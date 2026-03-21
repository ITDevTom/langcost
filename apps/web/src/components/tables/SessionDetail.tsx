import { useMemo, useState } from "react";

import type { SpanRecord, TraceDetailResponse, WasteReportRecord } from "../../api/client";
import {
  formatCategoryLabel,
  formatCompactInt,
  formatDateTime,
  formatDurationMs,
  formatUsd,
  statusClasses,
  traceLabel,
} from "../../lib/format";

interface SessionDetailProps {
  detail: TraceDetailResponse | null;
  loading: boolean;
  onViewTrace: () => void;
}

const INITIAL_VISIBLE_LLM_CALLS = 5;

function isModelInsight(report: WasteReportRecord): boolean {
  return report.category === "model_overuse";
}

function truncateText(value: string, maxLength = 72): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function getToolPreview(span: SpanRecord): string {
  const rawInput = span.toolInput?.trim();
  if (!rawInput) {
    return span.toolOutput ? truncateText(span.toolOutput) : "no input";
  }

  try {
    const parsed = JSON.parse(rawInput) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["path", "filePath", "file", "command", "cmd", "pattern", "query", "url"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0) {
          return truncateText(candidate);
        }
      }
    }
  } catch {}

  return truncateText(rawInput);
}

export function SessionDetail({ detail, loading, onViewTrace }: SessionDetailProps) {
  const [visibleCalls, setVisibleCalls] = useState(INITIAL_VISIBLE_LLM_CALLS);

  const actionableReports = useMemo(
    () => detail?.wasteReports.filter((report) => !isModelInsight(report)) ?? [],
    [detail],
  );
  const modelInsights = useMemo(() => detail?.wasteReports.filter(isModelInsight) ?? [], [detail]);

  const timeline = useMemo(() => {
    if (!detail) {
      return [];
    }

    const toolSpansByParent = new Map<string, SpanRecord[]>();
    for (const span of detail.spans) {
      if (span.type !== "tool" || !span.parentSpanId) {
        continue;
      }

      const siblings = toolSpansByParent.get(span.parentSpanId) ?? [];
      siblings.push(span);
      toolSpansByParent.set(span.parentSpanId, siblings);
    }

    return detail.spans
      .filter((span) => span.type === "llm")
      .sort(
        (left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime(),
      )
      .map((span, index) => ({
        index: index + 1,
        span,
        tools: [...(toolSpansByParent.get(span.id) ?? [])].sort(
          (left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime(),
        ),
      }));
  }, [detail]);

  if (loading) {
    return (
      <div className="detail-shell px-6 py-5 text-sm text-slate-400">
        Loading waste findings and execution timeline...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="detail-shell px-6 py-5 text-sm text-slate-500">
        Trace details unavailable.
      </div>
    );
  }

  const durationMs =
    detail.trace.endedAt && detail.trace.startedAt
      ? Math.max(
          0,
          new Date(detail.trace.endedAt).getTime() - new Date(detail.trace.startedAt).getTime(),
        )
      : null;
  const visibleTimeline = timeline.slice(0, visibleCalls);

  return (
    <div className="detail-shell px-6 py-6">
      <div className="panel p-5">
        <div className="flex flex-col gap-4 border-b border-[color:var(--border)] pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="section-kicker">Trace</div>
            <h3 className="mt-2 text-2xl font-semibold text-slate-50">
              {traceLabel(detail.trace.externalId, detail.trace.id)}
            </h3>
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-400">
              <span>Started: {formatDateTime(detail.trace.startedAt)}</span>
              <span>Duration: {formatDurationMs(durationMs)}</span>
              <span>Agent: {detail.trace.agentId ?? "unknown"}</span>
            </div>
          </div>

          <button type="button" onClick={onViewTrace} className="button-ghost">
            View all →
          </button>
        </div>

        {actionableReports.length > 0 || modelInsights.length > 0 ? (
          <section className="mt-5 rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-alt)] p-4">
            <div className="text-sm font-semibold text-slate-100">Trace Annotations</div>

            <div className="mt-3 space-y-3">
              {actionableReports.map((report) => (
                <div key={report.id} className="annotation-card annotation-card--warning">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-yellow-100">
                      ⚠ {formatCategoryLabel(report.category)}
                    </div>
                    <div className="text-red-300">{formatUsd(report.wastedCostUsd)}</div>
                  </div>
                  <div className="text-slate-300">{report.description}</div>
                  <div className="text-slate-500">{report.recommendation}</div>
                </div>
              ))}

              {modelInsights.map((report) => (
                <div key={report.id} className="annotation-card annotation-card--info">
                  <div className="font-medium text-blue-100">
                    ℹ {formatCategoryLabel(report.category)}
                  </div>
                  <div className="text-slate-300">{report.description}</div>
                  <div className="text-slate-500">{report.recommendation}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-slate-100">Execution Timeline</div>
              <div className="mt-1 text-sm text-slate-500">
                Numbered LLM calls with child tool calls underneath.
              </div>
            </div>
            <div className="text-sm text-slate-500">
              Showing {visibleTimeline.length} of {timeline.length} LLM calls
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {visibleTimeline.map(({ index, span, tools }) => (
              <div key={span.id} className="timeline-card">
                <div className="grid gap-3 text-sm lg:grid-cols-[60px_76px_92px_minmax(0,1fr)_110px_110px_90px_90px] lg:items-center">
                  <div className="font-semibold text-slate-100">#{index}</div>
                  <div className="font-medium text-slate-400">LLM</div>
                  <div className="text-slate-300">assistant</div>
                  <div className="truncate text-slate-100">{span.model ?? "unknown"}</div>
                  <div className="text-slate-300">in:{formatCompactInt(span.inputTokens ?? 0)}</div>
                  <div className="text-slate-300">
                    out:{formatCompactInt(span.outputTokens ?? 0)}
                  </div>
                  <div className="text-slate-100">{formatUsd(span.costUsd ?? 0)}</div>
                  <div className="lg:justify-self-end">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(span.status)}`}
                    >
                      {span.status}
                    </span>
                  </div>
                </div>

                {tools.length > 0 ? (
                  <div className="mt-4 space-y-2 border-l border-[color:var(--border)] pl-5">
                    {tools.map((toolSpan, toolIndex) => (
                      <div
                        key={toolSpan.id}
                        className="grid gap-2 text-sm text-slate-300 lg:grid-cols-[100px_110px_minmax(0,1fr)_90px] lg:items-center"
                      >
                        <div className="text-slate-500">
                          {toolIndex === tools.length - 1 ? "└─ tool" : "├─ tool"}
                        </div>
                        <div className="font-medium text-slate-100">
                          {toolSpan.toolName ?? "tool"}
                        </div>
                        <div className="truncate text-slate-400">{getToolPreview(toolSpan)}</div>
                        <div className="lg:justify-self-end">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-medium ${statusClasses(toolSpan.status)}`}
                          >
                            {toolSpan.status === "error" ? "error" : "ok"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-500">
              Total: {formatCompactInt(detail.trace.spanCount)} spans,{" "}
              {formatCompactInt(detail.trace.totalInputTokens)} input,{" "}
              {formatCompactInt(detail.trace.totalOutputTokens)} output.
            </div>

            <div className="flex flex-wrap gap-2">
              {timeline.length > visibleCalls ? (
                <button
                  type="button"
                  onClick={() => setVisibleCalls((current) => current + INITIAL_VISIBLE_LLM_CALLS)}
                  className="button-ghost"
                >
                  Load more
                </button>
              ) : null}

              <button type="button" onClick={onViewTrace} className="button-ghost">
                View all →
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
