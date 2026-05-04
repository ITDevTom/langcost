# @langcost/adapter-warp

LangCost adapter for [Warp](https://www.warp.dev/) — reads Oz agent session data directly from Warp's local SQLite database and ingests it into the langcost analysis engine.

## Quick start

```bash
# Install langcost + the adapter
npm install -g langcost @langcost/adapter-warp

# Scan your Warp sessions
langcost scan --source warp

# Open the dashboard
langcost dashboard
```

## How it works

Warp stores AI session data in a local SQLite database at:

```
~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite
```

The adapter reads three tables:

| Table | Maps to | Description |
|---|---|---|
| `agent_conversations` | `Trace` | One per Oz agent session — token totals, model, status |
| `ai_queries` | `Span (llm)` | One per exchange — model, timestamp, prompt, status |
| `blocks` | `Span (tool)` | One per `run_command` call — timing, exit code, output |

The database is opened **read-only** and Warp uses WAL mode, so scanning is safe while Warp is running.

## CLI options

```bash
# Scan the last 30 days (default)
langcost scan --source warp

# Scan all history
langcost scan --source warp --since all

# Point to a custom warp.sqlite path
langcost scan --source warp --path /path/to/warp.sqlite

# Force re-analysis of all sessions
langcost scan --source warp --force
```

## Waste detection

| Rule | Supported | Notes |
|---|---|---|
| `tool_failures` | ✅ | Detected via `blocks.exit_code ≠ 0` |
| `agent_loops` | ✅ | Repeated `run_command` patterns across exchanges |
| `model_overuse` | ✅ | Per-exchange model ID available |
| `retry_patterns` | ✅ | Consecutive failed/cancelled exchanges |
| `high_output` | ⚠️ approximate | Token counts are estimated (see limitations) |
| `low_cache` | ❌ | Cache hit/miss data not exposed per exchange |

## Known limitations

**Token counts are estimated, not exact.** Warp does not store per-exchange token counts in `ai_queries`. The adapter uses a two-signal estimation:
1. Estimates input size from the prompt JSON length using `estimateTokenCount`
2. Normalizes all estimates against the conversation's actual total from `conversation_data.token_usage`

Estimates sum to the exact conversation total and are proportionally accurate, but the input/output split is unknown — all tokens are treated as input for cost calculation. Aggregate cost per session is accurate; per-span cost is approximate.

**Tool spans cover `run_command` only.** Other tools (`read_files`, `grep`, `apply_file_diff`, etc.) are not persisted in the `blocks` table and cannot be reconstructed.

**No assistant response content.** Warp does not store the AI's response text. Only user messages (from the prompt) are available.

**macOS only.** Warp currently ships for macOS; the adapter auto-detects both Warp Stable and Warp Preview.

**Schema stability.** `warp.sqlite` is a private implementation detail of Warp and may change without notice. The adapter validates required tables at startup and fails with a clear error if the schema is incompatible.

## Auto-detection

The adapter checks for Warp Stable first, then Warp Preview:

1. `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite`
2. `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Preview/warp.sqlite`

Use `--path` to override.
