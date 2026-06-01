# Contributing to LangCost

Thanks for contributing! LangCost is a Bun monorepo with a **plugin architecture**: adapters ingest source data, analyzers turn normalized data into cost + fault intelligence, and they never touch each other. Most contributions fit one of four shapes — a waste rule, a fault rule, an adapter, or a pricing update.

## Prerequisites

- [Bun](https://bun.sh) (latest). No Node toolchain needed.

## Setup

```bash
git clone https://github.com/vjvkrm/langcost.git
cd langcost
bun install
```

## Everyday commands

```bash
bun run build       # compile every package to dist (tsc)
bun test            # run the full test suite
bun run typecheck   # tsc --noEmit across the monorepo
bun run lint        # Biome
bun run format      # Biome --write

bun run dev:api     # Hono API on :3737
bun run dev:web     # Vite dev server for the dashboard
```

**Before opening a PR, all of these must be green:**

```bash
bun run lint && bun test && bun run typecheck && bun run build
```

## Repo layout

```
packages/core/             @langcost/core — types, interfaces, pricing (zero deps)
packages/db/               @langcost/db — Drizzle schema + repositories (bun:sqlite)
packages/analyzers/        @langcost/analyzers — cost + fault analysis (source-agnostic)
packages/adapter-<name>/   @langcost/adapter-<name> — read one source, normalize it
packages/cli/              langcost — CLI; discovers adapters at runtime
apps/api/                  Hono REST API for the dashboard
apps/web/                  React + Vite + Tailwind dashboard
```

## Architecture rules (please respect)

These keep the plugin model intact — PRs that break them will be asked to rework:

- **Adapters only ingest + normalize.** They convert a source (JSONL, an API, a SQLite file) into normalized `Trace`/`Span`/`Message` rows. They **never** import `@langcost/analyzers` or know anything about analysis.
- **Analyzers are source-agnostic.** They read normalized data only and **never** import an adapter or reference a source format.
- **`@langcost/core` is zero-dependency.** Types, interfaces, pricing, pure utilities. Nothing in `core` imports `db`, `analyzers`, adapters, or apps.
- **DB access goes through `@langcost/db` repositories** — not raw SQL from analyzers/adapters/CLI/web.
- **The CLI loads adapters dynamically** (`import("@langcost/adapter-<name>")`); never add a static adapter import to the CLI.

## The four contribution shapes

### 🧩 Add a waste (cost) rule

1. Create `packages/analyzers/src/rules/my-rule.ts` exporting a `WasteRule` (`id`, `title`, `description`, `defaultEnabled`, optional `requires`/`defaultThresholds`, and `detect(contexts, config?)` returning `WasteReportRecord[]`). Copy an existing rule.
2. Register it in `packages/analyzers/src/rules/registry.ts` (`BUILTIN_RULES`) and export it from `rules/index.ts`.
3. Add a test in `packages/analyzers/test/`.
4. Set `requires` to the normalized data it needs (`"messages"`, `"cacheTokens"`, `"spans"`, …); the runner auto-skips — and explains — traces lacking it. Detection is **opt-in** — `defaultEnabled` is only a UI pre-check hint.
5. Set the metadata honestly:
   - **`tier`** — `2` if the rule needs message bodies, segment detail, or cache metadata (data beyond raw span token counts); `1` if it works off span token counts alone.
   - **`defaultEnabled`** — `false` for noisy or experimental heuristics; `true` only for high-precision rules. (Opt-in means this never auto-runs a rule — it only pre-checks it during onboarding.)

### 🧭 Add a fault-attribution rule

Same pattern, under `packages/analyzers/src/rules/fault/`: export a `FaultRule` (emits `FaultReportRecord[]` into `fault_reports`), register it in `rules/fault/registry.ts`. Attribute the **root cause** (`rootCauseSpanId`) + cascade, not just the symptom, and set an honest `confidence`. See `rules/fault/tool-cascade.ts` as the reference.

### 🔌 Build an adapter

1. Create `packages/adapter-<name>/` with `package.json` named `@langcost/adapter-<name>` (deps: `@langcost/core`, `@langcost/db`).
2. Export a default implementing `IAdapter` from `@langcost/core`, and set `meta.product` to `"coding"` or `"ai"`.
3. **Wrap each session's writes in a transaction:** `getSqliteClient(db).transaction(() => { ... })()` around the trace + spans + messages + `ingestion_state` upserts — keeps the SQLite writer lock short so concurrent scans don't collide. See `packages/adapter-warp/src/adapter.ts`.
4. The CLI discovers it automatically — no registration. Add it to the `KNOWN_ADAPTERS` catalog in `apps/api/src/routes/adapters.ts` so the dashboard lists it.

### 💲 Update model pricing

Edit `packages/core/src/pricing/providers.ts` — add models or fix prices. Unlisted models still produce token counts + waste findings; only cost shows as `$0`.

## Database migrations

Schema lives in `packages/db/src/schema/`. After changing it:

```bash
bun run --cwd packages/db db:generate   # drizzle-kit generates a new drizzle/*.sql migration
```

Commit the generated SQL + snapshot. Migrations apply automatically via `migrate()`.

## Testing notes

- Logic in `lib/` and rules get unit tests; React components/pages generally don't (presentation lives in components, testable logic in `lib/`).
- Cross-package imports (`@langcost/*`) resolve to **`dist`** — run `bun run build` before tests that exercise cross-package changes.

## Pull requests

- **Rebase on `main` first** and resolve conflicts before requesting review.
- Keep the four checks green (lint · test · typecheck · build).
- One logical change per PR where practical; conventional-commit titles (`feat:`, `fix:`, `chore:`).
- **`AGENTS.md` is the committed agent contract** — the tooling-agnostic dos/don'ts every agent (and contributor) should follow, enforced by `packages/architecture.test.ts`. Keep it in sync with this file.
- **Don't commit your own AI-tooling config.** `CLAUDE.md`, `.cursor/`, `.claude/`, `.codex/`, `.ai-context.yaml`, and internal design docs are gitignored on purpose — keep them local.

By contributing you agree your contributions are licensed under the repository's **AGPL-3.0** license.
