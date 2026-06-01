# AGENTS.md

The contract for any AI agent or contributor working in this repo — Claude, Cursor, Codex, or a
human. It is **tooling-agnostic**: it assumes only `bun` and `git`, and names no specific agent tool.
Read this first; the full detail lives in **[CONTRIBUTING.md](./CONTRIBUTING.md)**, which is the
canonical source — this file points at it and adds the must-follow dos/don'ts.

langcost is a Bun monorepo with a **plugin architecture**: adapters ingest source data and normalize
it; analyzers turn that normalized data into cost + fault intelligence; the two never touch each
other. See `CONTRIBUTING.md` → *Repo layout* and *The four contribution shapes* for recipes (add a
waste rule, a fault rule, an adapter, a pricing update).

## ✅ Do

- Read **CONTRIBUTING.md** before changing anything structural.
- Register new waste/fault rules in their registry (`packages/analyzers/src/rules/registry.ts` or
  `rules/fault/registry.ts`) and add a test under `packages/analyzers/test/`.
- Wrap each adapter session's writes in one `getSqliteClient(db).transaction(() => { ... })()`.
- Access the langcost database only through `@langcost/db` repositories.
- Use `nanoid` for IDs. Store dates as `integer({ mode: "timestamp_ms" })`, JSON as
  `text({ mode: "json" })`, money as `real` USD, token counts as integers, hashes via `crypto.subtle`.
- Install deps with `bun add` (never hand-write versions in `package.json`).

## ⛔ Don't — these fail CI (`packages/architecture.test.ts`)

- **Don't import an adapter from `packages/analyzers/**`.** Analyzers are source-agnostic: they read
  normalized data only and must never know which adapter produced it.
- **Don't add a static adapter import to `packages/cli/**`.** The CLI loads adapters dynamically via
  `import("@langcost/adapter-<name>")`; a static import breaks the plugin model.
- **Don't import any `@langcost/*` package from `packages/core/**`.** core is a zero-internal-dependency
  leaf — types, interfaces, pricing, and pure utilities only.

(Also enforced by review, not the test: **don't reach the DB with raw SQL** from
analyzers/adapters/CLI/web — go through `@langcost/db` repositories.)

## Conventions for a new waste / fault rule

- **`tier`** — `2` if the rule needs message bodies, segment detail, or cache metadata (data beyond
  raw span token counts); `1` if it works off span token counts alone.
- **`defaultEnabled`** — ship **`false`** for noisy or experimental heuristics; `true` only for
  high-precision rules. Detection is opt-in either way; this is just the onboarding pre-check hint.
- **`requires`** — declare every normalized data dependency (`"messages"`, `"cacheTokens"`,
  `"spans"`, …) so the runner can skip, and explain, traces that lack it.

## Before every PR

```bash
bun install
bun run lint && bun test && bun run typecheck && bun run build
```

All four must pass. `bun test` includes the architecture guardrails above, and
`.github/workflows/ci.yml` runs lint + test + typecheck on every PR.
