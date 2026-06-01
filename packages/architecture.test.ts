import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * Architecture guardrails — the committed, tooling-agnostic enforcement of langcost's layer
 * boundaries. These are the same invariants written in plain language in `AGENTS.md` /
 * `CONTRIBUTING.md`, expressed here as a test that fails CI for ANY contributor or agent —
 * regardless of whether they read the docs, use Claude/Cursor/Codex, or have `kk` installed.
 *
 * Scope is deliberately the three import-graph invariants that are exception-free and statically
 * checkable. The "DB access goes through @langcost/db repositories" rule is intentionally NOT
 * encoded here: adapters such as `adapter-warp` legitimately import `bun:sqlite` to read a SQLite
 * *source*, so that rule needs human / graph-tool judgement, not a blunt import check.
 */

const REPO_ROOT = join(import.meta.dir, "..");

/** Remove block and line comments so a `@langcost/...` mention in prose can't trip a rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // the [^:] guard leaves http:// alone
}

interface FileImports {
  file: string;
  staticSpecifiers: string[];
  dynamicSpecifiers: string[];
}

function collectImports(srcDir: string): FileImports[] {
  const glob = new Glob("**/*.{ts,tsx}");
  const files: FileImports[] = [];

  for (const rel of glob.scanSync({ cwd: join(REPO_ROOT, srcDir) })) {
    if (rel.endsWith(".d.ts")) {
      continue;
    }

    const source = stripComments(readFileSync(join(REPO_ROOT, srcDir, rel), "utf8"));

    const staticSpecifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g), // import/export ... from "x"
      ...source.matchAll(/\bimport\s*["']([^"']+)["']/g), // bare `import "x"`
    ].map((match) => match[1] as string);

    const dynamicSpecifiers = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map(
      (match) => match[1] as string,
    );

    files.push({ file: `${srcDir}/${rel}`, staticSpecifiers, dynamicSpecifiers });
  }

  return files;
}

function findForbidden(
  srcDir: string,
  isForbidden: (specifier: string) => boolean,
  options: { includeDynamic: boolean },
): string[] {
  const offenders: string[] = [];
  for (const { file, staticSpecifiers, dynamicSpecifiers } of collectImports(srcDir)) {
    const specifiers = options.includeDynamic
      ? [...staticSpecifiers, ...dynamicSpecifiers]
      : staticSpecifiers;
    for (const specifier of specifiers) {
      if (isForbidden(specifier)) {
        offenders.push(`${file} → "${specifier}"`);
      }
    }
  }
  return offenders;
}

const isAdapterImport = (specifier: string) => /@langcost\/adapter-/.test(specifier);
const isInternalPackageImport = (specifier: string) => /^@langcost\//.test(specifier);

describe("architecture invariants", () => {
  it("analyzers never import an adapter (analyzers are source-agnostic)", () => {
    // Analyzers read normalized traces/spans/messages/segments only; they must never know which
    // adapter produced the data. Both static and dynamic adapter imports are forbidden.
    const offenders = findForbidden("packages/analyzers/src", isAdapterImport, {
      includeDynamic: true,
    });
    expect(offenders).toEqual([]);
  });

  it("@langcost/core imports nothing from other @langcost packages (zero internal deps)", () => {
    // core is a leaf: types, interfaces, pricing, pure utilities. It must not pull in db, analyzers,
    // adapters, the CLI, or app packages.
    const offenders = findForbidden("packages/core/src", isInternalPackageImport, {
      includeDynamic: true,
    });
    expect(offenders).toEqual([]);
  });

  it("CLI never statically imports an adapter (adapters load dynamically via import())", () => {
    // Adapters are plugins, loaded at runtime via import("@langcost/adapter-<name>"). A *static*
    // import would break the plugin model; the dynamic import() in adapter-loader.ts is allowed.
    const offenders = findForbidden("packages/cli/src", isAdapterImport, {
      includeDynamic: false,
    });
    expect(offenders).toEqual([]);
  });
});
