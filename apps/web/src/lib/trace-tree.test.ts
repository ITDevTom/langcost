import { describe, expect, it } from "bun:test";

import type { SpanRecord } from "../api/client";
import { buildSpanTree, detectShape, lensFor, rollup } from "./trace-tree";

function mk(id: string, parentSpanId: string | null, extra: Partial<SpanRecord> = {}): SpanRecord {
  return {
    id,
    traceId: "t",
    externalId: id,
    type: "llm",
    startedAt: new Date(0).toISOString(),
    status: "ok",
    parentSpanId,
    ...extra,
  };
}

describe("buildSpanTree", () => {
  it("nests by parentSpanId and sets depth", () => {
    const roots = buildSpanTree([mk("a", null), mk("b", "a"), mk("c", "b"), mk("d", "a")]);
    expect(roots).toHaveLength(1);
    const a = roots[0];
    expect(a?.span.id).toBe("a");
    expect(a?.depth).toBe(0);
    expect(a?.children.map((n) => n.span.id).sort()).toEqual(["b", "d"]);
    const b = a?.children.find((n) => n.span.id === "b");
    expect(b?.depth).toBe(1);
    expect(b?.children[0]?.span.id).toBe("c");
    expect(b?.children[0]?.depth).toBe(2);
  });

  it("treats a span whose parent is missing/outside the set as a root", () => {
    const roots = buildSpanTree([mk("a", "ghost"), mk("b", null)]);
    expect(roots.map((n) => n.span.id).sort()).toEqual(["a", "b"]);
  });

  it("orders children by startedAt", () => {
    const roots = buildSpanTree([
      mk("a", null),
      mk("late", "a", { startedAt: new Date(2000).toISOString() }),
      mk("early", "a", { startedAt: new Date(1000).toISOString() }),
    ]);
    expect(roots[0]?.children.map((n) => n.span.id)).toEqual(["early", "late"]);
  });

  it("terminates on a cycle and keeps every span exactly once", () => {
    const roots = buildSpanTree([mk("a", "b"), mk("b", "a")]); // mutual parents
    const ids: string[] = [];
    const stack = [...roots];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      ids.push(n.span.id);
      for (const c of n.children) stack.push(c);
    }
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("returns [] for no spans", () => {
    expect(buildSpanTree([])).toEqual([]);
  });
});

describe("rollup (own vs descendant cost)", () => {
  it("sums own + descendants and preserves null when no cost data exists", () => {
    const roots = buildSpanTree([
      mk("agent", null, { type: "agent" }), // own cost null
      mk("llm1", "agent", { costUsd: 0.1, inputTokens: 100, outputTokens: 20 }),
      mk("llm2", "agent", { costUsd: 0.2, inputTokens: 200, outputTokens: 30 }),
      mk("tool", "agent", { type: "tool" }), // own cost null, no children
    ]);
    const agent = roots[0];
    expect(agent?.ownCostUsd).toBeNull();
    expect(agent?.subtreeCostUsd).toBeCloseTo(0.3, 8); // rolled up from llm children
    expect(agent?.subtreeTokens).toBe(350);
    const tool = agent?.children.find((n) => n.span.id === "tool");
    expect(tool?.ownCostUsd).toBeNull();
    expect(tool?.subtreeCostUsd).toBeNull(); // "—", not "$0"
  });

  it("is idempotent and re-derivable via the exported rollup()", () => {
    const roots = buildSpanTree([mk("a", null, { costUsd: 1 }), mk("b", "a", { costUsd: 2 })]);
    rollup(roots);
    expect(roots[0]?.subtreeCostUsd).toBe(3);
  });
});

describe("detectShape + lensFor", () => {
  it("classifies a shallow llm+tool trace as the coding lens (Log, expanded)", () => {
    const shape = detectShape([mk("llm", null), mk("tool", "llm", { type: "tool" })]);
    expect(shape.lens.id).toBe("coding");
    expect(shape.lens.defaultView).toBe("log");
    expect(shape.lens.showFaultSeams).toBe(false);
    expect(shape.maxDepth).toBe(1);
  });

  it("classifies a trace with retrieval/agent spans as the production lens (Tree, reliability on)", () => {
    const shape = detectShape([
      mk("agent", null, { type: "agent" }),
      mk("retr", "agent", { type: "retrieval" }),
      mk("llm", "retr", { type: "llm" }),
    ]);
    expect(shape.lens.id).toBe("production");
    expect(shape.lens.defaultView).toBe("tree");
    expect(shape.lens.showReliability).toBe(true);
    expect(shape.hasRetrieval).toBe(true);
  });

  it("classifies a deep (>=2) llm-only trace as production by depth", () => {
    const shape = detectShape([mk("a", null), mk("b", "a"), mk("c", "b")]);
    expect(shape.maxDepth).toBe(2);
    expect(shape.lens.id).toBe("production");
  });

  it("lensFor coding never collapses (fully expanded)", () => {
    expect(lensFor("coding").collapseDepth).toBe(Number.POSITIVE_INFINITY);
    expect(lensFor("production").collapseDepth).toBe(2);
  });
});
