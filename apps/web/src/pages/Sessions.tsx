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
import { formatPercent, formatRelativeTime, formatUsd } from "../lib/format";

interface SessionsProps {
  refreshToken: number;
  onNavigate: (path: string) => void;
}

const PAGE_SIZE = 50;

export function Sessions({ refreshToken, onNavigate }: SessionsProps) {
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
            ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          }),
          getOverview(),
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
  }, [page, refreshToken, sort, statusFilter]);

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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5">
      {overview ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              label: "Total Cost",
              value: formatUsd(overview.totalCostUsd),
              detail: `${overview.costByModel.length} models observed`,
              tone: "summary-card--blue",
            },
            {
              label: "Actionable Waste",
              value: formatUsd(overview.totalWastedUsd),
              detail: formatPercent(overview.wastePercentage),
              tone: "summary-card--rose",
            },
            {
              label: "Sessions",
              value: `${overview.totalTraces}`,
              detail: `${overview.tracesWithWaste} with waste findings`,
              tone: "summary-card--green",
            },
            {
              label: "Last Scan",
              value: formatRelativeTime(overview.lastScanAt),
              detail: overview.lastScanAt ?? "No scans yet",
              tone: "summary-card--amber",
            },
          ].map((card) => (
            <div key={card.label} className={`summary-card ${card.tone}`}>
              <div className="summary-label">{card.label}</div>
              <div className="summary-value">{card.value}</div>
              <div className="summary-detail">{card.detail}</div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="section-kicker">Trace Explorer</div>
          <h1 className="mt-2 text-3xl font-semibold text-slate-50">Traces</h1>
          <p className="section-copy mt-2 text-sm">
            Expand a trace to inspect waste findings and the execution timeline.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
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
      ) : traces.length === 0 ? (
        <div className="panel p-8 text-sm text-slate-500">No traces found yet.</div>
      ) : (
        <div className="table-shell overflow-hidden rounded-[28px] border border-[color:var(--border)] bg-[color:var(--surface)]">
          <div className="overflow-x-auto">
            <table className="trace-table min-w-[1160px] w-full table-fixed border-collapse">
              <colgroup>
                <col style={{ width: "92px" }} />
                <col style={{ width: "34%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "84px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "110px" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-[color:var(--border)] text-xs tracking-[0.18em] text-slate-500 uppercase">
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Session</th>
                  <th className="px-4 py-3 text-left font-medium">Model</th>
                  <th className="px-4 py-3 text-right font-medium">Spans</th>
                  <th className="px-4 py-3 text-right font-medium">Input</th>
                  <th className="px-4 py-3 text-right font-medium">Output</th>
                  <th className="px-4 py-3 text-right font-medium">Cost</th>
                  <th className="px-4 py-3 text-right font-medium">Waste</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace) => {
                  const expanded = expandedIds.has(trace.id);
                  return (
                    <Fragment key={trace.id}>
                      <SessionRow
                        trace={trace}
                        expanded={expanded}
                        onToggle={() => void toggleRow(trace.id)}
                      />
                      {expanded ? (
                        <tr>
                          <td colSpan={8} className="p-0">
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
