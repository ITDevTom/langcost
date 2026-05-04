# Spec: `@langcost/adapter-warp`

**Status:** Draft  
**Date:** 2026-05-04  
**Author:** Amirault

---

## What

A langcost adapter that reads Warp AI session data from its local SQLite database and ingests it
into the langcost SQLite, enabling cost and waste analysis for Warp users.

Users would run:

```bash
npm install -g langcost @langcost/adapter-warp
langcost scan --source warp
langcost dashboard
```

---

## Why

Warp is an AI-powered terminal where users run Oz agents (powered by Claude) throughout their
development workflow. Each session can involve dozens of LLM exchanges. Users have no built-in
way to understand:

- Total tokens and cost per session or over time
- Which sessions burned the most money
- Whether their agents are looping or retrying excessively
- How model choices (Sonnet vs Haiku) affect spend

LangCost already provides this intelligence for Claude Code and OpenClaw. Warp users are a natural
third target: they are developers who are already thinking about agentic workflows and cost.

---

## Current State (Research Findings)

Warp stores its AI session data in a private SQLite database:

```
~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite
```

Two tables are relevant:

### `agent_conversations`

One row per conversation (a top-level Oz agent session).

| Column | Type | Content |
|---|---|---|
| `conversation_id` | TEXT | UUID — primary identifier |
| `conversation_data` | TEXT | JSON blob (see below) |
| `last_modified_at` | TIMESTAMP | Last update time |

`conversation_data` JSON structure (observed):
```json
{
  "server_conversation_token": "uuid",
  "run_id": "uuid",
  "autoexecute_override": "RunToCompletion",
  "conversation_usage_metadata": {
    "was_summarized": false,
    "context_window_usage": 0.062613,
    "credits_spent": 0.0,
    "credits_spent_for_last_block": 0.0,
    "token_usage": [
      {
        "model_id": "Claude Haiku 4.5",
        "warp_tokens": 0,
        "byok_tokens": 25534,
        "warp_token_usage_by_category": {},
        "byok_token_usage_by_category": { "full_terminal_use": 25534 }
      },
      {
        "model_id": "Claude Sonnet 4.6",
        "warp_tokens": 0,
        "byok_tokens": 800034,
        "warp_token_usage_by_category": {},
        "byok_token_usage_by_category": { "primary_agent": 800034 }
      }
    ],
    "tool_usage_metadata": {
      "run_command_stats": { "count": 13, "commands_executed": 12 },
      "read_files_stats": { "count": 3 },
      "apply_file_diff_stats": { "count": 0, "lines_added": 0, "lines_removed": 0, "files_changed": 0 }
    }
  }
}
```

Notable:
- Token totals are **aggregated per model per conversation** — not per exchange.
- `credits_spent` is always `0.0` for BYOK users (Warp does not record actual API cost for
  bring-your-own-key setups).
- The `warp_tokens` vs `byok_tokens` split matters: `warp_tokens` are billed by Warp (credits);
  `byok_tokens` are billed by the user's own API key.

### `ai_queries`

One row per exchange (a single user prompt → assistant response cycle).

| Column | Type | Content |
|---|---|---|
| `exchange_id` | TEXT | UUID — primary identifier |
| `conversation_id` | TEXT | FK → `agent_conversations.conversation_id` |
| `start_ts` | DATETIME | Timestamp of the request |
| `input` | TEXT | JSON array — the user query and rich context (see below) |
| `output_status` | TEXT | `"Completed"`, presumably also error states |
| `model_id` | TEXT | Model ID (e.g., `"claude-4-6-sonnet-high"`) |
| `planning_model_id` | TEXT | Usually empty |
| `coding_model_id` | TEXT | Usually empty |
| `working_directory` | TEXT | CWD at time of query |

`input` JSON structure (observed):
```json
[
  {
    "Query": {
      "text": "User message text here",
      "context": [
        { "Directory": { "pwd": "/path/to/cwd", "home_dir": "/Users/..." } },
        { "Git": { "head": "main", "branch": "main" } },
        { "CurrentTime": { "current_time": "2026-05-04T..." } },
        { "ExecutionEnvironment": { "os": { "category": "MacOS" }, "shell_name": "zsh" } }
      ]
    }
  }
]
```

---

## Mapping to LangCost Types

| LangCost Type | Warp Source |
|---|---|
| `Trace` | One per `agent_conversations` row |
| `Span` (type=`llm`) | One per `ai_queries` row belonging to that conversation |
| `Span` (type=`tool`) | **Cannot reconstruct** — only aggregate counts available |
| `Message` (role=`user`) | Extracted from `ai_queries.input[0].Query.text` |
| `Message` (role=`assistant`) | **Not stored** — Warp does not persist the AI response text |

### Trace fields

| Field | Source |
|---|---|
| `id` | `"warp:trace:{conversation_id}"` |
| `externalId` | `conversation_id` |
| `source` | `"warp"` |
| `startedAt` | `MIN(ai_queries.start_ts)` for the conversation |
| `endedAt` | `last_modified_at` (approximation) |
| `totalInputTokens` | Sum of all `token_usage[*].byok_tokens + warp_tokens` (approximate — not split by input/output) |
| `totalOutputTokens` | **Unknown** — not available separately |
| `totalCostUsd` | Estimated via `calculateCost()` using aggregate tokens (BYOK) or `credits_spent` (Warp) |
| `model` | Primary model from `token_usage` (highest token count) |
| `status` | `"complete"` if all exchanges succeeded, `"error"` if any failed |

### Span (LLM exchange) fields

| Field | Source |
|---|---|
| `id` | `"warp:span:{exchange_id}"` |
| `externalId` | `exchange_id` |
| `type` | `"llm"` |
| `startedAt` | `start_ts` |
| `model` | `model_id` (after normalization — see Blockers) |
| `inputTokens` | **Not available** — must be estimated or omitted |
| `outputTokens` | **Not available** — not stored |
| `costUsd` | **Not available** per span — only per conversation |
| `status` | `"ok"` if `output_status = "Completed"`, else `"error"` |

---

## Blockers

### Blocker 1 — No per-exchange token counts (CRITICAL)

**Problem:** The `ai_queries` table has no `input_tokens` or `output_tokens` columns. Token data
is only available as an aggregate at the conversation level in `agent_conversations.conversation_data`.

**Impact:**
- Cannot calculate cost per span (LLM exchange).
- The `high_output` waste rule will not fire (requires per-span output token counts).
- The `low_cache` rule will not work per-span (cache read/write tokens not tracked per exchange).
- Per-span cost display in the trace explorer will be `$0` or estimated.

**Options:**
1. **Accept the limitation** — show cost at conversation (trace) level only; spans show `$0`.
   Simplest, honest, but limits waste detection depth.
2. **Estimate proportionally** — distribute conversation-level tokens across spans proportionally
   by `input` JSON byte size. Rough approximation but allows per-span cost estimates.
3. **Wait for Warp to expose this data** — file a feature request with Warp to add token counts
   to `ai_queries`.

**Recommended approach:** Option 1 for the initial implementation, document the limitation clearly.
Option 2 can be added as a `--estimate-tokens` flag in a follow-up.

---

### Blocker 2 — No output message content

**Problem:** Warp does not store the AI assistant's response text. Only the user's input query is
available in `ai_queries.input`.

**Impact:**
- Cannot reconstruct `Message` records for `role=assistant`.
- The `high_output` rule (which flags spans with abnormally long responses) cannot analyze content.
- Trace explorer will show user messages but no assistant messages.

**Options:**
1. **Accept the limitation** — only ingest `user` messages; skip `assistant` messages.
2. **Read from Warp blocks table** — the `blocks` table might contain terminal output. Investigate
   further.

**Recommended approach:** Option 1 for the initial implementation.

---

### Blocker 3 — SQLite locking

**Problem:** Warp keeps `warp.sqlite` open while the app is running. Direct reads may fail or
return stale WAL data if Warp is holding an exclusive lock.

**Impact:** `langcost scan` may fail or return incomplete data when Warp is open.

**Mitigation:** Use SQLite WAL mode (which allows concurrent readers) and open the database
read-only (`PRAGMA query_only = ON`). If the lock cannot be acquired, fail gracefully with a
clear error message directing the user to quit Warp first.

SQLite WAL mode is the default for many applications; Warp likely already uses it (evidenced by
the presence of `warp.sqlite-wal` and `warp.sqlite-shm` files).

---

### Blocker 4 — Model ID mapping

**Problem:** Warp uses its own model ID strings (e.g., `"claude-4-6-sonnet-high"`,
`"Claude Sonnet 4.6"`, `"Claude Haiku 4.5"`) that differ from the pricing model IDs in
`@langcost/core` (e.g., `"claude-sonnet-4-6"`, `"claude-haiku-4-5"`).

**Impact:** `calculateCost()` will return `$0` for unknown model IDs.

**Mitigation:** Add a Warp-specific model ID normalization map in the adapter:

```
"claude-4-6-sonnet-high" → "claude-sonnet-4-6"
"Claude Sonnet 4.6"      → "claude-sonnet-4-6"
"Claude Haiku 4.5"       → "claude-haiku-4-5"
"claude-4-6-haiku"       → "claude-haiku-4-5"
```

This map must be maintained as Warp adds new model options. The `model_id` field in `ai_queries`
(snake_case, e.g., `"claude-4-6-sonnet-high"`) and the `model_id` in `conversation_data.token_usage`
(display name, e.g., `"Claude Sonnet 4.6"`) are different formats — both need mapping.

---

### Blocker 5 — Private, undocumented database schema

**Problem:** `warp.sqlite` is a private implementation detail of Warp. The schema is not publicly
documented and can change at any time without notice. A schema migration in Warp could silently
break the adapter.

**Impact:** Maintenance burden. Breaking changes could go undetected until users report errors.

**Mitigation:**
- Add schema version detection: read `__diesel_schema_migrations` to verify expected tables exist.
- Add defensive JSON parsing — use optional chaining everywhere; never throw on unexpected shape.
- Test against multiple Warp versions in CI if possible.
- Document the risk in the adapter README.

---

### Blocker 6 — BYOK vs Warp tokens

**Problem:** The `token_usage` in `conversation_data` splits tokens into `warp_tokens` (billed by
Warp, consumed as credits) and `byok_tokens` (billed via the user's own API key). The `credits_spent`
field is always `0.0` for BYOK users; Warp does not record the actual monetary cost for BYOK usage.

**Impact:** For BYOK users, `totalCostUsd` must be estimated via `calculateCost()` using
`byok_tokens`. For Warp-credit users, the `credits_spent` field could be used but does not
directly map to USD.

**Recommended approach:** For BYOK users, estimate cost via `calculateCost(model, tokens, 0)` on
the aggregate token sum (treating all as input since input/output split is unavailable). For
Warp-credit users, store `credits_spent` in metadata and flag that cost is in credits, not USD.

---

## How (Proposed Implementation)

### Package structure

Following the existing adapter convention:

```
packages/adapter-warp/
├── package.json          # @langcost/adapter-warp
├── src/
│   ├── index.ts          # exports warpAdapter as default
│   ├── adapter.ts        # implements IAdapter<Db>
│   ├── discovery.ts      # locates warp.sqlite
│   ├── reader.ts         # opens SQLite (read-only), queries tables
│   ├── normalizer.ts     # maps Warp rows → Trace, Span[], Message[]
│   └── types.ts          # TypeScript types for Warp's JSON shapes
└── test/
    ├── normalizer.test.ts
    └── discovery.test.ts
```

### Source path

Default:
```
~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite
```

Can be overridden via `--path`.

### Read strategy

The adapter uses Bun's native SQLite (`bun:sqlite`) to open the Warp database in read-only mode:

```typescript
const db = new Database(warpDbPath, { readonly: true });
```

Queries:

```sql
-- All conversations modified within --since window
SELECT conversation_id, conversation_data, last_modified_at
FROM agent_conversations
WHERE last_modified_at >= ?
ORDER BY last_modified_at ASC;

-- All exchanges for discovered conversations
SELECT exchange_id, conversation_id, start_ts, input, output_status, model_id, working_directory
FROM ai_queries
WHERE conversation_id IN (...)
ORDER BY start_ts ASC;
```

### Normalizer

Each `agent_conversations` row becomes one `Trace`.
Each `ai_queries` row becomes one `Span` of type `llm`.
User query text from `ai_queries.input` becomes one `Message` of role `user`.

Token and cost data at the trace level comes from `conversation_data.conversation_usage_metadata`.
Span-level tokens default to `null` (see Blocker 1).

### Incremental ingestion

Unlike the file-based adapters, Warp's source is a SQLite DB with no file-size or hash to compare.
Use `last_modified_at` from `agent_conversations` and the `updatedAt` from the `ingestion_state`
repository to skip conversations that have not changed since last scan.

---

## Acceptance Criteria

1. `langcost scan --source warp` successfully reads `warp.sqlite` and ingests conversations as traces.
2. Each `ai_queries` row is ingested as an `llm` span within its parent trace.
3. User query text is ingested as a `user` message attached to the span.
4. `model_id` values are normalized to known pricing model IDs where possible.
5. Token counts are available at the trace level (from `conversation_usage_metadata`).
6. Span-level token counts are `null` (with a clear note in the README that per-exchange tokens are unavailable).
7. `langcost validate --source warp` correctly detects whether `warp.sqlite` exists and is readable.
8. If `warp.sqlite` is locked or inaccessible, the adapter fails with a human-readable message (not a crash).
9. Incremental scans skip conversations not modified since the last scan.
10. The adapter works on macOS (primary target). Linux/Windows support is out of scope (Warp is macOS-only for now).
11. All waste detection rules that are compatible with the available data work correctly:
    - `tool_failures`: partially — only detects if `output_status` ≠ "Completed", not individual tool call failures.
    - `agent_loops`: does not fire (requires per-span tool call data).
    - `retry_patterns`: fires on multiple consecutive exchanges where `output_status` indicates failure.
    - `high_output`: does not fire (no per-span output token counts).
    - `low_cache`: does not fire (no cache token data per span).
    - `model_overuse`: fires if 100% of exchanges use an expensive model.

---

## Out of Scope

- Reconstructing assistant response content (not stored by Warp).
- Per-span token counts (not available in current Warp schema).
- Individual tool call span reconstruction (only aggregate counts available).
- Windows and Linux support (Warp is macOS-only currently).
- Warp Preview channel support (different bundle ID; can be added later with `--channel` flag).

---

## Open Questions

1. **Does Warp use WAL mode?** If not, concurrent reads while Warp is running may silently
   return incomplete data. Need to verify with `PRAGMA journal_mode`.

2. **Can `blocks` table be used for assistant output?** The `blocks` table exists in the schema.
   Investigation needed to determine if it contains AI response text that could be used to
   populate `assistant` messages.

3. **What does `output_status` look like for failed exchanges?** Only `"Completed"` has been
   observed. Understanding the error values is needed to correctly set span `status = "error"`.

4. **Warp Stable vs Preview?** Warp Preview uses bundle ID `dev.warp.Warp-Preview`. Should the
   adapter support both by default or require a flag?

5. **Token category breakdown:** The `byok_token_usage_by_category` field contains categories
   like `"primary_agent"`, `"full_terminal_use"`. Could these be used to split input/output
   tokens at the trace level? Would need Warp to clarify the semantics.

---

## References

- LangCost `IAdapter` interface: `packages/core/src/interfaces/adapter.ts`
- Claude Code adapter (reference implementation): `packages/adapter-claude-code/`
- OpenClaw adapter (alternative reference): `packages/adapter-openclaw/`
- Warp SQLite location: `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`
- Observed Warp schema version: Diesel migrations (table: `__diesel_schema_migrations`)
