import { Fragment, useEffect, useState } from "react";

import {
  getOverview,
  getTraceDetail,
  getTraces,
  type OverviewResponse,
  type TraceDetailResponse,
  type TraceSummary,
} from "../api/client";
import { SessionDetail } from "../components/tables/SessionDetail";
import { SessionRow } from "../components/tables/SessionRow";
import { formatCompactInt, formatPercent, formatRelativeTime, formatUsd } from "../lib/format";

interface SessionsProps {
  refreshToken: number;
  onNavigate: (path: string) => void;
  source?: string;
  billingMode: "subscription" | "api";
}

const PAGE_SIZE = 50;

export function Sessions({ refreshToken, onNavigate, source, billingMode }: SessionsProps) {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("date_desc");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, TraceDetailResponse>>({});
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refreshToken;
    let active = true;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const [traceResponse, overviewResponse] = await Promise.all([
          getTraces({
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
            sort,
            source,
            ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          }),
          getOverview(source),
        ]);

        if (!active) {
          return;
        }

        setTraces(traceResponse.traces);
        setTotal(traceResponse.total);
        setOverview(overviewResponse);
      } catch (cause) {
        if (!active) {
          return;
        }

        setError(cause instanceof Error ? cause.message : "Failed to load sessions.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [page, refreshToken, sort, source, statusFilter]);

  async function toggleRow(traceId: string) {
    const nextExpanded = new Set(expandedIds);
    if (nextExpanded.has(traceId)) {
      nextExpanded.delete(traceId);
      setExpandedIds(nextExpanded);
      return;
    }

    nextExpanded.add(traceId);
    setExpandedIds(nextExpanded);

    if (details[traceId] || loadingDetails.has(traceId)) {
      return;
    }

    const nextLoading = new Set(loadingDetails);
    nextLoading.add(traceId);
    setLoadingDetails(nextLoading);

    try {
      const detail = await getTraceDetail(traceId);
      setDetails((current) => ({ ...current, [traceId]: detail }));
    } finally {
      setLoadingDetails((current) => {
        const updated = new Set(current);
        updated.delete(traceId);
        return updated;
      });
    }
  }

  const isClaudeCode = source === "claude-code";
  const isApi = billingMode === "api";
  const showCost = isApi;
  const showCache = isApi && isClaudeCode;
  const showWaste = isApi;

  // Group subagent traces under their parent for claude-code
  const { parentTraces, subagentsByParent } = (() => {
    const parents: TraceSummary[] = [];
    const subs = new Map<string, TraceSummary[]>();

    for (const trace of traces) {
      const parentId = (trace.metadata as Record<string, unknown> | null)?.parentConversationId as string | null;
      if (parentId) {
        const parentTraceId = `${trace.source}:trace:${parentId}`;
        if (!subs.has(parentTraceId)) subs.set(parentTraceId, []);
        subs.get(parentTraceId)!.push(trace);
      } else {
        parents.push(trace);
      }
    }

    return { parentTraces: parents, subagentsByParent: subs };
  })();

  // Roll up subagent totals
  function getCacheCost(trace: TraceSummary): number {
    const meta = trace.metadata as Record<string, unknown> | null;
    const readTokens = typeof meta?.totalCacheReadTokens === "number" ? meta.totalCacheReadTokens : 0;
    const writeTokens = typeof meta?.totalCacheCreationTokens === "number" ? meta.totalCacheCreationTokens : 0;
    return (readTokens / 1_000_000) * 0.5 + (writeTokens / 1_000_000) * 10;
  }

  interface ModelTokens { model: string; tokens: number }

  function getModelBreakdown(trace: TraceSummary, subagents: TraceSummary[]): ModelTokens[] {
    const byModel = new Map<string, number>();
    const all = [trace, ...subagents];
    for (const t of all) {
      const model = t.model ?? "unknown";
      const tokens = t.totalInputTokens + t.totalOutputTokens;
      byModel.set(model, (byModel.get(model) ?? 0) + tokens);
    }
    return [...byModel.entries()]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  function getDisplayTrace(trace: TraceSummary): TraceSummary & { subagentCount: number; project?: string; cacheCost: number; modelBreakdown: ModelTokens[] } {
    const subagents = subagentsByParent.get(trace.id) ?? [];
    const project = (trace.metadata as Record<string, unknown> | null)?.project as string | undefined;
    return {
      ...trace,
      totalInputTokens: trace.totalInputTokens + subagents.reduce((sum, sa) => sum + sa.totalInputTokens, 0),
      totalOutputTokens: trace.totalOutputTokens + subagents.reduce((sum, sa) => sum + sa.totalOutputTokens, 0),
      totalCostUsd: trace.totalCostUsd + subagents.reduce((sum, sa) => sum + sa.totalCostUsd, 0),
      wasteUsd: trace.wasteUsd + subagents.reduce((sum, sa) => sum + sa.wasteUsd, 0),
      spanCount: trace.spanCount + subagents.reduce((sum, sa) => sum + sa.spanCount, 0),
      subagentCount: subagents.length,
      project,
      cacheCost: getCacheCost(trace) + subagents.reduce((sum, sa) => sum + getCacheCost(sa), 0),
      modelBreakdown: getModelBreakdown(trace, subagents),
    };
  }

  const displayTraces = parentTraces.map(getDisplayTrace);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const colSpan = (isClaudeCode ? 6 : 5) + (showCost ? 1 : 0) + (showCache ? 1 : 0) + (showWaste ? 1 : 0);

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5">
      {overview ? (
        <section className="stat-strip">
          {showCost ? (
            <>
              <span className="stat-strip__item">
                <span className="stat-strip__label">Total:</span> {formatUsd(overview.totalCostUsd)}
              </span>
              <span className="stat-strip__separator">|</span>
              <span className="stat-strip__item">
                <span className="stat-strip__label">Waste:</span> {formatUsd(overview.totalWastedUsd)} (
                {formatPercent(overview.wastePercentage)})
              </span>
              <span className="stat-strip__separator">|</span>
            </>
          ) : null}
          <span className="stat-strip__item">
            <span className="stat-strip__label">Sessions:</span> {parentTraces.length}
          </span>
          {showCache && (overview.totalCacheReadTokens > 0 || overview.totalCacheWriteTokens > 0) ? (() => {
            const cacheReadCost = (overview.totalCacheReadTokens / 1_000_000) * 0.5;
            const cacheWriteCost = (overview.totalCacheWriteTokens / 1_000_000) * 10;
            const totalCacheCost = cacheReadCost + cacheWriteCost;
            return (
              <>
                <span className="stat-strip__separator">|</span>
                <span
                  className="stat-strip__item"
                  title={`Cache read: ${formatCompactInt(overview.totalCacheReadTokens)} tokens → ${formatUsd(cacheReadCost)}\nCache write: ${formatCompactInt(overview.totalCacheWriteTokens)} tokens → ${formatUsd(cacheWriteCost)}`}
                >
                  <span className="stat-strip__label">Cache:</span>{" "}
                  <span style={{ color: "var(--text-muted)" }}>
                    {formatUsd(totalCacheCost)}
                  </span>
                </span>
              </>
            );
          })() : null}
          <span className="stat-strip__separator">|</span>
          <span className="stat-strip__item">
            <span className="stat-strip__label">Last scan:</span>{" "}
            {formatRelativeTime(overview.lastScanAt)}
          </span>
        </section>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          Sessions
          <span className="ml-2 text-sm font-normal" style={{ color: "var(--text-muted)" }}>
            ({parentTraces.length})
          </span>
        </h1>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-400">
            <span className="mr-2">Sort</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
              className="field-shell rounded-xl px-3 py-2"
            >
              <option value="date_desc">Date</option>
              <option value="cost_desc">Cost</option>
              <option value="waste_desc">Waste</option>
            </select>
          </label>

          <label className="text-sm text-slate-400">
            <span className="mr-2">Filter</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              className="field-shell rounded-xl px-3 py-2"
            >
              <option value="all">All</option>
              <option value="complete">OK</option>
              <option value="error">Error</option>
              <option value="partial">Partial</option>
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="panel p-8 text-sm text-slate-400">Loading traces...</div>
      ) : error ? (
        <div className="panel p-8 text-sm text-red-300">{error}</div>
      ) : displayTraces.length === 0 ? (
        <div className="panel p-8 text-sm text-slate-500">No traces found yet.</div>
      ) : (
        <div className="table-shell overflow-hidden rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)]">
          <div className="overflow-x-auto">
            <table className="trace-table min-w-[1160px] w-full table-fixed border-collapse">
              <colgroup>
                <col style={{ width: "80px" }} />
                {isClaudeCode ? <col style={{ width: "110px" }} /> : null}
                <col />
                <col style={{ width: "14%" }} />
                <col style={{ width: "70px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "90px" }} />
                {showCost ? <col style={{ width: "90px" }} /> : null}
                {showCache ? <col style={{ width: "90px" }} /> : null}
                {showWaste ? <col style={{ width: "90px" }} /> : null}
              </colgroup>
              <thead>
                <tr className="border-b border-[color:var(--border)] text-xs tracking-[0.18em] text-slate-500 uppercase">
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  {isClaudeCode ? <th className="px-4 py-3 text-left font-medium">Project</th> : null}
                  <th className="px-4 py-3 text-left font-medium">Session</th>
                  <th className="px-4 py-3 text-left font-medium">Model</th>
                  <th className="px-4 py-3 text-right font-medium">Spans</th>
                  <th className="px-4 py-3 text-right font-medium">Input</th>
                  <th className="px-4 py-3 text-right font-medium">Output</th>
                  {showCost ? <th className="px-4 py-3 text-right font-medium">Cost</th> : null}
                  {showCache ? <th className="px-4 py-3 text-right font-medium">Cache</th> : null}
                  {showWaste ? <th className="px-4 py-3 text-right font-medium">Waste</th> : null}
                </tr>
              </thead>
              <tbody>
                {displayTraces.map((trace) => {
                  const expanded = expandedIds.has(trace.id);
                  return (
                    <Fragment key={trace.id}>
                      <SessionRow
                        trace={trace}
                        expanded={expanded}
                        onToggle={() => void toggleRow(trace.id)}
                        showProject={isClaudeCode}
                        project={trace.project}
                        subagentCount={trace.subagentCount}
                        showCost={showCost}
                        showCache={showCache}
                        cacheCost={trace.cacheCost}
                        showWaste={showWaste}
                        modelBreakdown={trace.modelBreakdown}
                      />
                      {expanded ? (
                        <tr onClick={(e) => e.stopPropagation()}>
                          <td colSpan={colSpan} className="p-0">
                            <SessionDetail
                              detail={details[trace.id] ?? null}
                              loading={loadingDetails.has(trace.id)}
                              onViewTrace={() => onNavigate(`/traces/${trace.id}`)}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
        <div>
          Page {page} of {totalPages}. Showing {traces.length} of {total} traces.
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
            className="button-secondary rounded-xl px-3 py-2 text-sm"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
            className="button-secondary rounded-xl px-3 py-2 text-sm"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
