import { useMemo, useState } from "react";

import type { MessageRecord, SpanRecord, WasteReportRecord } from "../../api/client";
import { formatCompactInt, formatUsd } from "../../lib/format";
import { buildSpanTree, detectShape, type Lens, type TreeNode } from "../../lib/trace-tree";
import { Badge, type BadgeProps } from "../ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

// Presentation only. All tree/cost/shape logic lives in lib/trace-tree.ts (pure, unit-tested).
// Data comes in as props — this component never fetches (backend access stays in api/client).

const TYPE_LABEL: Record<SpanRecord["type"], string> = {
  llm: "LLM",
  tool: "TOOL",
  retrieval: "RETR",
  agent: "AGENT",
};

// Distinct hue per span type (reusing palette tokens): llm = brand accent (cost-bearing), tool =
// yellow, retrieval = green, agent = violet. Drives both the type badge and the waterfall bar.
const TYPE_COLOR: Record<SpanRecord["type"], string> = {
  llm: "var(--accent-orange)",
  tool: "var(--accent-yellow)",
  retrieval: "var(--accent-green)",
  agent: "var(--accent-purple)",
};

// Same hues expressed as Badge tones for the type tag.
const TYPE_TONE: Record<SpanRecord["type"], NonNullable<BadgeProps["tone"]>> = {
  llm: "accent",
  tool: "warn",
  retrieval: "ok",
  agent: "info",
};

const AUTO_COLLAPSE_OVER = 40; // only auto-collapse deep nodes for large traces

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

interface TraceTreeProps {
  spans: SpanRecord[];
  messages: MessageRecord[];
  wasteReports: WasteReportRecord[];
  /** Root-cause span ids from fault_reports — highlighted with ⊙ in the tree. */
  rootCauseSpanIds?: string[];
  /** Spans on a fault cascade — highlighted with ▲. */
  affectedSpanIds?: string[];
  /** Overrides the shape-detected default lens. */
  lens?: Lens;
}

interface VisibleRow {
  node: TreeNode;
  hasChildren: boolean;
  collapsed: boolean;
}

/** Pre-order flatten respecting collapse. `collapsedIds === null` => show everything (Log view). */
function flatten(roots: TreeNode[], collapsedIds: Set<string> | null): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (node: TreeNode): void => {
    const hasChildren = node.children.length > 0;
    const collapsed = collapsedIds?.has(node.span.id) ?? false;
    rows.push({ node, hasChildren, collapsed });
    if (hasChildren && !collapsed) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  for (const root of roots) {
    walk(root);
  }
  return rows;
}

function indexWasteBySpan(reports: WasteReportRecord[]): Map<string, WasteReportRecord[]> {
  const map = new Map<string, WasteReportRecord[]>();
  for (const report of reports) {
    if (!report.spanId) {
      continue;
    }
    const list = map.get(report.spanId);
    if (list) {
      list.push(report);
    } else {
      map.set(report.spanId, [report]);
    }
  }
  return map;
}

function initialCollapsed(roots: TreeNode[], lens: Lens, spanCount: number): Set<string> {
  const collapsed = new Set<string>();
  if (spanCount <= AUTO_COLLAPSE_OVER || !Number.isFinite(lens.collapseDepth)) {
    return collapsed;
  }
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.depth >= lens.collapseDepth && node.children.length > 0) {
      collapsed.add(node.span.id);
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return collapsed;
}

function severityColor(severity: WasteReportRecord["severity"]): string {
  if (severity === "critical" || severity === "high") {
    return "var(--accent-red)";
  }
  if (severity === "medium") {
    return "var(--accent-yellow)";
  }
  return "var(--text-secondary)";
}

function cost(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.005) return "<$0.01"; // sub-cent: don't render as $0.00
  return formatUsd(value);
}

export function TraceTree({
  spans,
  messages,
  wasteReports,
  rootCauseSpanIds,
  affectedSpanIds,
  lens: lensOverride,
}: TraceTreeProps) {
  const shape = useMemo(() => detectShape(spans), [spans]);
  const lens = lensOverride ?? shape.lens;
  const roots = useMemo(() => buildSpanTree(spans), [spans]);
  const wasteBySpan = useMemo(() => indexWasteBySpan(wasteReports), [wasteReports]);
  const affected = useMemo(() => new Set(affectedSpanIds ?? []), [affectedSpanIds]);
  const rootCauses = useMemo(() => new Set(rootCauseSpanIds ?? []), [rootCauseSpanIds]);

  // Trace time window for the latency waterfall. Span timestamps arrive as JSON strings.
  const timeline = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const s of spans) {
      const start = new Date(s.startedAt).getTime();
      const end = s.endedAt ? new Date(s.endedAt).getTime() : start;
      if (start < min) min = start;
      if (end > max) max = end;
    }
    return { min, total: Math.max(max - min, 1) };
  }, [spans]);

  const [view, setView] = useState<"log" | "tree">(lens.defaultView);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    initialCollapsed(roots, lens, spans.length),
  );
  const [openSpanId, setOpenSpanId] = useState<string | null>(null);

  const isLog = view === "log";
  // Tree = nested hierarchy (indented, collapsible). Log = flat chronological stream of every span
  // ordered by start time (no indentation/carets) — so the toggle is visibly meaningful even on
  // shallow traces, and Log reads like a timeline next to the waterfall.
  const treeRows = useMemo(() => flatten(roots, collapsed), [roots, collapsed]);
  const logRows = useMemo(() => {
    const all = flatten(roots, null);
    return [...all].sort(
      (a, b) =>
        new Date(a.node.span.startedAt).getTime() - new Date(b.node.span.startedAt).getTime(),
    );
  }, [roots]);
  const rows = isLog ? logRows : treeRows;

  function toggleCollapse(spanId: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  }

  if (spans.length === 0) {
    return <div className="px-5 py-4 text-sm text-slate-500">No spans in this trace.</div>;
  }

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] px-5 py-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          Execution tree{" "}
          <span className="font-normal text-[var(--text-muted)]">
            · {spans.length} span{spans.length === 1 ? "" : "s"} · {formatDuration(timeline.total)}{" "}
            · {shape.lens.id} lens
          </span>
        </h2>
        <Tabs value={view} onValueChange={(value) => setView(value as "log" | "tree")}>
          <TabsList aria-label="Trace view">
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="tree">Tree</TabsTrigger>
            <TabsTrigger value="graph" disabled title="Graph view — coming with deep agent runs">
              Graph
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="font-mono text-[13px] leading-6">
        {rows.map(({ node, hasChildren, collapsed: isCollapsed }) => {
          const span = node.span;
          const spanWaste = wasteBySpan.get(span.id) ?? [];
          const isError = span.status === "error";
          const isRootCause = rootCauses.has(span.id);
          const isAffected = affected.has(span.id);
          const isOpen = openSpanId === span.id;
          const spanMessages = isOpen ? messages.filter((m) => m.spanId === span.id) : [];

          const startMs = new Date(span.startedAt).getTime();
          const endMs = span.endedAt ? new Date(span.endedAt).getTime() : startMs;
          const durMs = span.durationMs ?? (span.endedAt ? endMs - startMs : null);
          const offsetPct = ((startMs - timeline.min) / timeline.total) * 100;
          const widthPct = Math.min(
            Math.max(((durMs ?? 0) / timeline.total) * 100, 1.2),
            100 - offsetPct,
          );

          return (
            <div key={span.id} className="border-b border-[color:var(--border)]/40 last:border-b-0">
              <div
                className={`span-row flex w-full items-center gap-2 px-3 py-1.5 ${isOpen ? "span-row--selected" : ""}`}
                style={{ paddingLeft: `${0.75 + (isLog ? 0 : node.depth) * 1.25}rem` }}
              >
                {!isLog && hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(span.id)}
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                    className="w-3 text-slate-500"
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="w-3" />
                )}

                <button
                  type="button"
                  onClick={() => setOpenSpanId(isOpen ? null : span.id)}
                  className="flex flex-1 items-center gap-2 overflow-hidden text-left"
                >
                  <Badge
                    tone={TYPE_TONE[span.type]}
                    className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-px text-[10px] uppercase tracking-[0.08em]"
                  >
                    {TYPE_LABEL[span.type]}
                  </Badge>
                  <span className="truncate text-slate-200" style={{ maxWidth: "18rem" }}>
                    {span.name ?? span.toolName ?? span.type}
                  </span>
                  {span.model ? (
                    <span className="hidden truncate text-slate-500 lg:inline">{span.model}</span>
                  ) : null}
                  {span.inputTokens != null || span.outputTokens != null ? (
                    <span className="hidden shrink-0 text-slate-500 xl:inline">
                      {formatCompactInt(span.inputTokens ?? 0)}↑{" "}
                      {formatCompactInt(span.outputTokens ?? 0)}↓
                    </span>
                  ) : null}

                  <span className="ml-auto flex shrink-0 items-center gap-3 tabular-nums">
                    {spanWaste.map((report) => (
                      <span
                        key={report.id}
                        className="hidden items-center gap-1 md:inline-flex"
                        style={{ color: severityColor(report.severity) }}
                        title={report.description}
                      >
                        ⚠ {report.category.replace(/_/g, " ")}
                      </span>
                    ))}
                    {isRootCause ? (
                      <span style={{ color: "var(--accent-red)" }}>⊙ root cause</span>
                    ) : isAffected ? (
                      <span style={{ color: "var(--accent-red)" }}>▲ affected</span>
                    ) : null}

                    {/* Latency waterfall: bar offset by start, width by duration, colored by type. */}
                    <span className="hidden items-center gap-2 sm:flex">
                      <span className="waterfall-track w-24">
                        <span
                          className="waterfall-bar"
                          style={{
                            left: `${offsetPct}%`,
                            width: `${widthPct}%`,
                            backgroundColor: isError ? "var(--accent-red)" : TYPE_COLOR[span.type],
                          }}
                        />
                      </span>
                      <span className="w-12 text-right text-slate-500">
                        {formatDuration(durMs)}
                      </span>
                    </span>

                    <span
                      className="w-16 text-right text-slate-100"
                      title={`own ${cost(node.ownCostUsd)} · subtree (own + descendants)`}
                    >
                      {cost(node.subtreeCostUsd)}
                    </span>
                    <span
                      className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: isError ? "var(--accent-red)" : "var(--accent-green)",
                      }}
                      title={isError ? "error" : "ok"}
                    />
                  </span>
                </button>
              </div>

              {isOpen ? (
                <div className="bg-[color:var(--surface-alt)] px-4 py-3 text-xs text-slate-400">
                  {span.errorMessage ? (
                    <div className="mb-2 text-red-300">error: {span.errorMessage}</div>
                  ) : null}
                  {span.type === "tool" ? (
                    <div className="space-y-1">
                      <div>
                        <span className="text-slate-500">input:</span> {span.toolInput ?? "—"}
                      </div>
                      <div>
                        <span className="text-slate-500">output:</span> {span.toolOutput ?? "—"}
                      </div>
                    </div>
                  ) : spanMessages.length > 0 ? (
                    <div className="space-y-1">
                      {spanMessages.map((message) => (
                        <div key={message.id}>
                          <span className="text-slate-500">{message.role}:</span>{" "}
                          {message.content.slice(0, 400)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-600">No message bodies captured for this span.</div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
