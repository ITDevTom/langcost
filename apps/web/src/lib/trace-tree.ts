// Pure span-tree helpers for the adaptive trace renderer (no React, no DOM — unit-tested).
// Builds one recursive tree from the flat normalized spans (nested by parentSpanId) that BOTH the
// coding (shallow) and production (deep) lenses render — see dashboard_redesign.md §3/§9.

import type { SpanRecord } from "../api/client";

export interface TreeNode {
  span: SpanRecord;
  depth: number;
  children: TreeNode[];
  /** This span's own cost. `null` = not attributed by the adapter → render "—", never a misleading "$0". */
  ownCostUsd: number | null;
  /** Own + all descendants. `null` only when neither this span nor any descendant has cost data. */
  subtreeCostUsd: number | null;
  /** This span's own input+output tokens (`null` when unknown). */
  ownTokens: number | null;
  /** Own + all descendants. */
  subtreeTokens: number | null;
}

export type LensId = "coding" | "production";

export interface Lens {
  id: LensId;
  defaultView: "log" | "tree";
  /** Collapse nodes deeper than this for large traces. `Infinity` = always fully expanded. */
  collapseDepth: number;
  showReliability: boolean;
  /** Whether the Faults nav slot + drawer Fault tab + root-cause markers render (production only). */
  showFaultSeams: boolean;
}

export interface TraceShape {
  spanCount: number;
  maxDepth: number;
  hasRetrieval: boolean;
  hasAgent: boolean;
  lens: Lens;
}

function startTime(span: SpanRecord): number {
  const t = new Date(span.startedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function ownCostOf(span: SpanRecord): number | null {
  return typeof span.costUsd === "number" ? span.costUsd : null;
}

function ownTokensOf(span: SpanRecord): number | null {
  const input = span.inputTokens;
  const output = span.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") {
    return null;
  }
  return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
}

/**
 * Build the span tree from the flat list, nested by `parentSpanId`. Iterative (no recursion) so deep
 * production traces can't overflow the stack. Robust to: null/missing parents and parents outside the
 * set (→ roots), self-parents, and cycles (the back-edge is dropped; every span appears exactly once).
 * Children are ordered by `startedAt`, and cost/token rollups are populated.
 */
export function buildSpanTree(spans: SpanRecord[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const span of spans) {
    nodes.set(span.id, {
      span,
      depth: 0,
      children: [],
      ownCostUsd: ownCostOf(span),
      subtreeCostUsd: null,
      ownTokens: ownTokensOf(span),
      subtreeTokens: null,
    });
  }

  // Index child ids by parent (only valid, non-self parents present in the set); the rest are roots.
  const childIds = new Map<string, string[]>();
  const explicitRootIds: string[] = [];
  for (const span of spans) {
    const parentId = span.parentSpanId;
    if (parentId && parentId !== span.id && nodes.has(parentId)) {
      const siblings = childIds.get(parentId);
      if (siblings) {
        siblings.push(span.id);
      } else {
        childIds.set(parentId, [span.id]);
      }
    } else {
      explicitRootIds.push(span.id);
    }
  }

  const roots: TreeNode[] = [];
  const visited = new Set<string>();

  // Link a root's whole subtree, iteratively (parent processed before children; cycle-safe via visited).
  const attachSubtree = (rootId: string): void => {
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || visited.has(id)) {
        continue;
      }
      visited.add(id);
      const node = nodes.get(id);
      if (!node) {
        continue;
      }
      const kids = (childIds.get(id) ?? [])
        .map((childId) => nodes.get(childId))
        .filter((child): child is TreeNode => child !== undefined)
        .sort((a, b) => startTime(a.span) - startTime(b.span));
      for (const kid of kids) {
        if (visited.has(kid.span.id)) {
          continue; // cycle back-edge — drop it
        }
        kid.depth = node.depth + 1;
        node.children.push(kid);
        stack.push(kid.span.id);
      }
    }
  };

  const rootNodes = explicitRootIds
    .map((id) => nodes.get(id))
    .filter((node): node is TreeNode => node !== undefined)
    .sort((a, b) => startTime(a.span) - startTime(b.span));
  for (const root of rootNodes) {
    if (visited.has(root.span.id)) {
      continue;
    }
    root.depth = 0;
    roots.push(root);
    attachSubtree(root.span.id);
  }

  // Sweep any spans orphaned by a cycle (never reached from a real root) → promote to roots.
  for (const span of spans) {
    if (!visited.has(span.id)) {
      const node = nodes.get(span.id);
      if (!node) {
        continue;
      }
      node.depth = 0;
      roots.push(node);
      attachSubtree(span.id);
    }
  }

  rollup(roots);
  return roots;
}

/**
 * Populate `subtreeCostUsd` / `subtreeTokens` bottom-up. Reverse pre-order guarantees every descendant
 * is computed before its ancestor without recursion. `null` is preserved when no cost/token data
 * exists anywhere in the subtree (so the UI shows "—" rather than a misleading "$0").
 */
export function rollup(roots: TreeNode[]): TreeNode[] {
  const order: TreeNode[] = [];
  const stack: TreeNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    order.push(node);
    for (const child of node.children) {
      stack.push(child);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    if (!node) {
      continue;
    }
    let costSum = 0;
    let costAny = node.ownCostUsd !== null;
    if (node.ownCostUsd !== null) {
      costSum += node.ownCostUsd;
    }
    let tokenSum = 0;
    let tokenAny = node.ownTokens !== null;
    if (node.ownTokens !== null) {
      tokenSum += node.ownTokens;
    }
    for (const child of node.children) {
      if (child.subtreeCostUsd !== null) {
        costSum += child.subtreeCostUsd;
        costAny = true;
      }
      if (child.subtreeTokens !== null) {
        tokenSum += child.subtreeTokens;
        tokenAny = true;
      }
    }
    node.subtreeCostUsd = costAny ? costSum : null;
    node.subtreeTokens = tokenAny ? tokenSum : null;
  }

  return roots;
}

/** Default lens for a detected shape. Coding = shallow Log; production = collapsible Tree + reliability. */
export function lensFor(id: LensId): Lens {
  return id === "production"
    ? { id, defaultView: "tree", collapseDepth: 2, showReliability: true, showFaultSeams: true }
    : {
        id,
        defaultView: "log",
        collapseDepth: Number.POSITIVE_INFINITY,
        showReliability: false,
        showFaultSeams: false,
      };
}

/**
 * Classify a trace by shape and pick a default lens. A coding session is the shallow degenerate case
 * (llm + direct tools, no retrieval/agent); a production agent run is deep or has retrieval/agent spans.
 */
export function detectShape(spans: SpanRecord[]): TraceShape {
  const roots = buildSpanTree(spans);
  let maxDepth = 0;
  const stack: TreeNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.depth > maxDepth) {
      maxDepth = node.depth;
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }

  const hasRetrieval = spans.some((span) => span.type === "retrieval");
  const hasAgent = spans.some((span) => span.type === "agent");
  const spanCount = spans.length;
  const isProduction = hasRetrieval || hasAgent || maxDepth >= 2 || spanCount > 30;

  return {
    spanCount,
    maxDepth,
    hasRetrieval,
    hasAgent,
    lens: lensFor(isProduction ? "production" : "coding"),
  };
}
