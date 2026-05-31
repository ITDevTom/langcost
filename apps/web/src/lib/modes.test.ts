import { describe, expect, it } from "bun:test";

import { modeForSource, resolveInitialMode, sourcesForMode } from "./modes";

describe("modeForSource", () => {
  it("classifies observability/production sources as the AI-agents product", () => {
    expect(modeForSource("langfuse")).toBe("ai");
    expect(modeForSource("langsmith")).toBe("ai");
    expect(modeForSource("langwatch")).toBe("ai");
    expect(modeForSource("otel")).toBe("ai");
    expect(modeForSource("sample")).toBe("ai"); // seeded production-shaped demo data
  });

  it("classifies local dev-tool sources (and unknowns) as the coding-agents product", () => {
    for (const s of ["openclaw", "claude-code", "warp", "cline", "codex"]) {
      expect(modeForSource(s)).toBe("coding");
    }
    expect(modeForSource("some-future-cli")).toBe("coding");
    expect(modeForSource(undefined)).toBe("coding");
  });
});

describe("sourcesForMode", () => {
  const sources = [
    { name: "openclaw" },
    { name: "langfuse" },
    { name: "codex" },
    { name: "sample" },
  ];

  it("keeps only the sources belonging to the requested mode", () => {
    expect(sourcesForMode(sources, "coding").map((s) => s.name)).toEqual(["openclaw", "codex"]);
    expect(sourcesForMode(sources, "ai").map((s) => s.name)).toEqual(["langfuse", "sample"]);
  });
});

describe("resolveInitialMode", () => {
  const coding = [{ name: "openclaw" }];
  const ai = [{ name: "langfuse" }];
  const both = [{ name: "openclaw" }, { name: "langfuse" }];

  it("honors a saved choice when that mode actually has data", () => {
    expect(resolveInitialMode(both, "ai")).toBe("ai");
    expect(resolveInitialMode(both, "coding")).toBe("coding");
  });

  it("ignores a saved choice whose mode has no data and falls back to one with data", () => {
    expect(resolveInitialMode(coding, "ai")).toBe("coding");
    expect(resolveInitialMode(ai, "coding")).toBe("ai");
  });

  it("prefers coding when both modes have data and nothing is saved", () => {
    expect(resolveInitialMode(both, null)).toBe("coding");
  });

  it("defaults gracefully when there is no data at all", () => {
    expect(resolveInitialMode([], null)).toBe("coding");
    expect(resolveInitialMode([], "ai")).toBe("ai"); // respect the saved preference on an empty install
  });
});
