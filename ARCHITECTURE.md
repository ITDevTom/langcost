# langcost Architecture

This document explains how the langcost monorepo is laid out, what gets published to npm, and **why**. Read this before changing the packaging, the release script, or how the CLI loads the dashboard.

## TL;DR

- **One user-facing package: `langcost` (the CLI).** It bundles the dashboard (Hono API + prebuilt React web app) inside its tarball, so `npm i -g langcost && langcost dashboard` works with zero extra installs.
- **Three internal published packages: `@langcost/core`, `@langcost/db`, `@langcost/analyzers`.** They are public on npm because the CLI and the adapters depend on them, but users never install them directly.
- **Adapters are separate published packages: `@langcost/adapter-openclaw`, `@langcost/adapter-claude-code`, `@langcost/adapter-warp`, ...** Users opt into the adapter for their tool.
- **Two packages exist in the repo but are NOT published: `@langcost/api`, `@langcost/web`.** They are workspace-only build inputs that get copied into the `langcost` CLI tarball at publish time.

## Repository layout

```
packages/
  core/                  → @langcost/core         (published, internal)
  db/                    → @langcost/db           (published, internal)
  analyzers/             → @langcost/analyzers    (published, internal)
  adapter-openclaw/      → @langcost/adapter-openclaw  (published, user-facing)
  adapter-claude-code/   → @langcost/adapter-claude-code (published, user-facing)
  adapter-warp/          → @langcost/adapter-warp (published, user-facing)
  cli/                   → langcost               (published, user-facing)

apps/
  api/                   → @langcost/api          (NOT published — bundled into CLI)
  web/                   → @langcost/web          (NOT published — bundled into CLI)
```

## Data flow

```
1. INGEST:  source data → adapter → normalized Traces/Spans/Messages → SQLite (~/.langcost/langcost.db)
2. ANALYZE: SQLite → @langcost/analyzers (cost-analyzer, waste-detector) → segments + waste_reports tables
3. PRESENT: SQLite → CLI terminal report   (langcost report)
                  → Hono API + React app   (langcost dashboard)
```

The CLI is the only entry point users invoke. Adapters are loaded dynamically via `import(@langcost/adapter-${name})` — the CLI never statically imports an adapter.

## Publishing model

### What gets published, and why

| Package                          | Published | Audience            | Why                                                                |
| -------------------------------- | --------- | ------------------- | ------------------------------------------------------------------ |
| `langcost`                       | Yes       | End users           | The CLI binary. Bundles the dashboard.                             |
| `@langcost/core`                 | Yes       | Internal / adapters | Types, interfaces, pricing. Adapters depend on this.               |
| `@langcost/db`                   | Yes       | Internal / adapters | Drizzle schema + repositories. Adapters write through these.       |
| `@langcost/analyzers`            | Yes       | Internal            | Cost + waste analysis. Currently only the CLI consumes this.       |
| `@langcost/adapter-openclaw`     | Yes       | End users           | Optional install for OpenClaw users.                               |
| `@langcost/adapter-claude-code`  | Yes       | End users           | Optional install for Claude Code users.                            |
| `@langcost/adapter-warp`         | Yes       | End users           | Optional install for Warp users.                                   |
| `@langcost/api`                  | **No**    | —                   | Hono server. Source is copied into the `langcost` tarball.         |
| `@langcost/web`                  | **No**    | —                   | React dashboard. Built output is copied into the `langcost` tarball. |

### Install story

```bash
# Just want the CLI + dashboard
npm i -g langcost

# Add the adapter for your tool
npm i -g @langcost/adapter-warp
# or
npm i -g @langcost/adapter-claude-code
```

`langcost dashboard` must work after the first command alone — no separate `@langcost/api` install required.

## Why this shape?

We considered three architectures. Each is recorded here so the trade-offs are not relitigated every six months.

### Option A — Publish everything, including api + web (REJECTED)

Each app/package becomes its own npm package: `@langcost/api`, `@langcost/web`, plus core/db/analyzers/adapters/cli. The CLI declares `@langcost/api` as a runtime dependency.

**Why we rejected it:**

- This is the shape that produced the original bug we are fixing: `langcost dashboard` failed on global install with `Cannot find module '.../apps/api/src/index.ts'` because `@langcost/api` was never actually published. Two packages were privately marked `"private": true` while the CLI tried to import them at runtime.
- Eight published packages for a single product is more release coordination than the surface area justifies.
- `@langcost/api` and `@langcost/web` are not libraries anyone would consume on their own — they are implementation details of the dashboard.

### Option B — Bundle everything into `langcost`, adapters use peer-dep (REJECTED)

Merge `core`, `db`, `analyzers`, `api`, `web` source into `packages/cli/` so only `langcost` and the adapters get published. Adapters declare `langcost` as a `peerDependency` and import from subpath exports like `import { IAdapter } from "langcost/core"`.

**Why we rejected it:**

1. **Peer-dep UX is fragile across global/local install combinations.** A globally installed `langcost` plus a locally installed adapter (or vice versa) is not reliably resolvable by node's module resolution. Old npm versions emit confusing peer warnings. Users hit silent runtime mismatches when CLI and adapter versions drift.
2. **Public API surface explodes.** Every type and function exported under `langcost/core`, `langcost/db`, `langcost/analyzers` becomes part of the CLI's public contract for adapter authors. Renaming a repository method or adjusting a schema column becomes a breaking CLI release instead of an internal refactor.
3. **Coarser releases.** A patch to `@langcost/db` would force a `langcost` release and an adapter peer-range bump. Today, `@langcost/db` can ship a patch independently; only consumers that actually pull the new version see the change.
4. **Bigger refactor blast radius.** Every adapter's imports, every adapter's `package.json`, the CLI's `exports` map, the release script, and a chunk of test fixtures all change. ~20 files vs. ~5 for the chosen approach.
5. **Mixed import styles in the monorepo.** `apps/api` (now living inside `packages/cli/`) imports `core`/`db` via relative paths, while adapter packages still resolve the same code via workspace symlinks. Two ways to import the same module is a long-term maintenance smell.

The intuition that motivated this option — "I published too many packages last time" — was correct, but the actual offenders were `@langcost/api` and `@langcost/web`, not `@langcost/core`/`@langcost/db`/`@langcost/analyzers`. Those three are well-factored libraries that adapters legitimately depend on, and dressing them up as subpath exports of the CLI would solve a problem we do not have.

### Option C — Bundle api + web into `langcost`, keep core/db/analyzers as published packages (CHOSEN)

Only `apps/api/src/` and `apps/web/dist/` are folded into the `langcost` tarball at publish time. `core`, `db`, `analyzers` remain ordinary npm packages.

**Why this won:**

- **Fixes the reported bug directly.** The dashboard files are inside the same tarball as the CLI binary, so `langcost dashboard` works after a single `npm i -g langcost`.
- **No peer-dependency gymnastics.** Adapters declare `@langcost/core` and `@langcost/db` as normal `dependencies`. npm de-dupes them across the CLI and any adapters the user installs.
- **Independent versioning of the libraries that actually matter.** Schema changes ship as `@langcost/db` releases. Cost-pricing updates ship as `@langcost/core` releases. The CLI does not have to re-publish in lockstep.
- **Smallest refactor.** The `langcost` package gains a prepack step that copies api source + web build into the tarball; the dashboard command's loader switches from a fragile fallback path to a stable bundled-in path. Adapter packages, core, db, analyzers, and the release script see minimal changes.
- **Honest packaging.** `@langcost/api` and `@langcost/web` stop being publishable-but-unpublished packages with `"private": true`. They become what they actually are: build inputs for the CLI.

## How the CLI bundles the dashboard

At publish time, `packages/cli`'s `prepack` step copies:

- `apps/api/src/` → `packages/cli/dashboard/api/`
- `apps/web/dist/` → `packages/cli/dashboard/web/`

The CLI's `dashboard` command imports the API entry from the bundled-in path inside its own package, not from `@langcost/api`. The API resolves the web build relative to its own location, so it finds `dashboard/web/` automatically when running from a globally-installed `langcost`.

In local development, nothing is copied — `apps/api` and `apps/web` are still workspace packages, `bun run dev:api` and `bun run dev:web` work as before, and the CLI falls back to importing them via the workspace.

## How adapters work

Adapters are independent npm packages that:

1. Implement the `IAdapter` interface from `@langcost/core`.
2. Read source-specific data and write normalized rows via `@langcost/db` repositories.
3. Are discovered by the CLI at runtime via `import(@langcost/adapter-${name})` — never statically imported.

This means adding a new adapter is a non-breaking change to the CLI: ship a new `@langcost/adapter-foo` package, the CLI picks it up the moment a user installs it.

## Rules for future changes

- **Do not add a static adapter import to `packages/cli/`.** The CLI must remain source-agnostic.
- **Do not import adapters from `@langcost/analyzers`.** Analyzers run only against normalized data.
- **Do not publish `@langcost/api` or `@langcost/web`.** If you find yourself wanting to, re-read the Option A and Option B sections above.
- **Do not turn `@langcost/core`/`@langcost/db`/`@langcost/analyzers` into subpath exports of `langcost`.** Re-read Option B.
- **Do not hand-write versions in `package.json`.** Use `bun add` so the lockfile stays in sync.
- **All published packages must stay in sync on the monorepo version.** The release script enforces this; do not work around it.
