import { useMemo, useState } from "react";

import type { SpanRecord, TraceDetailResponse, WasteReportRecord } from "../../api/client";
import { formatCompactInt, formatUsd } from "../../lib/format";

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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getStringEvidence(record: WasteReportRecord, key: string): string | null {
  const value = record.evidence[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumberEvidence(record: WasteReportRecord, key: string): number | null {
  const value = record.evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getArrayLengthEvidence(record: WasteReportRecord, key: string): number | null {
  const value = record.evidence[key];
  return Array.isArray(value) ? value.length : null;
}

function modelFamily(model: string): string {
  const head = model.split(/[-/]/u)[0]?.trim() ?? model;
  if (head.length === 0) {
    return "Model";
  }

  return head.charAt(0).toUpperCase() + head.slice(1);
}

function formatWasteSummary(report: WasteReportRecord): string {
  switch (report.category) {
    case "tool_failure_waste": {
      const failures = getArrayLengthEvidence(report, "failedToolSpanIds") ?? 0;
      return `${pluralize(failures, "tool failure")} (${formatUsd(report.wastedCostUsd)})`;
    }
    case "high_output":
      return `verbose span (${formatUsd(report.wastedCostUsd)})`;
    case "retry_waste": {
      const retries = getNumberEvidence(report, "retryCount") ?? 0;
      return `${pluralize(retries, "retry")} (${formatUsd(report.wastedCostUsd)})`;
    }
    case "agent_loop": {
      const repeats = getArrayLengthEvidence(report, "repeatedToolSpanIds") ?? 0;
      return `${pluralize(repeats + 1, "looped call")} (${formatUsd(report.wastedCostUsd)})`;
    }
    case "low_cache_utilization": {
      const spans = getArrayLengthEvidence(report, "spanIds") ?? 0;
      return `${pluralize(spans, "low-cache span")} (${formatUsd(report.wastedCostUsd)})`;
    }
    case "model_overuse": {
      const share = getNumberEvidence(report, "dominantShare");
      const dominantModel = getStringEvidence(report, "dominantModel");
      if (share !== null && dominantModel) {
        return `${Math.round(share * 100)}% ${modelFamily(dominantModel)}`;
      }

      return "model insight";
    }
    default:
      return report.description;
  }
}

function formatWasteSummaryGroup(category: string, reports: WasteReportRecord[]): string {
  const totalWasteUsd = reports.reduce((total, report) => total + report.wastedCostUsd, 0);
  const primary = reports[0];
  if (!primary) {
    return "";
  }

  switch (category) {
    case "high_output":
      return `${pluralize(reports.length, "verbose span")} (${formatUsd(totalWasteUsd)})`;
    case "tool_failure_waste": {
      const failures = reports.reduce(
        (total, report) => total + (getArrayLengthEvidence(report, "failedToolSpanIds") ?? 0),
        0,
      );
      return `${pluralize(failures, "tool failure")} (${formatUsd(totalWasteUsd)})`;
    }
    case "retry_waste": {
      const retries = reports.reduce(
        (total, report) => total + (getNumberEvidence(report, "retryCount") ?? 0),
        0,
      );
      return `${pluralize(retries, "retry")} (${formatUsd(totalWasteUsd)})`;
    }
    case "agent_loop": {
      const repeatedCalls = reports.reduce(
        (total, report) => total + (getArrayLengthEvidence(report, "repeatedToolSpanIds") ?? 0) + 1,
        0,
      );
      return `${pluralize(repeatedCalls, "looped call")} (${formatUsd(totalWasteUsd)})`;
    }
    case "low_cache_utilization": {
      const spans = reports.reduce(
        (total, report) => total + (getArrayLengthEvidence(report, "spanIds") ?? 0),
        0,
      );
      return `${pluralize(spans, "low-cache span")} (${formatUsd(totalWasteUsd)})`;
    }
    case "model_overuse":
      return formatWasteSummary(primary);
    default:
      return formatWasteSummary(primary);
  }
}

function timelineStatusLabel(status: "ok" | "error"): string {
  return status === "error" ? "error" : "ok";
}

export function SessionDetail({ detail, loading, onViewTrace }: SessionDetailProps) {
  const [visibleCalls, setVisibleCalls] = useState(INITIAL_VISIBLE_LLM_CALLS);

  const actionableReports = useMemo(
    () => detail?.wasteReports.filter((report) => !isModelInsight(report)) ?? [],
    [detail],
  );
  const modelInsights = useMemo(() => detail?.wasteReports.filter(isModelInsight) ?? [], [detail]);
  const wasteSegments = useMemo(() => {
    const groupedActionable = new Map<string, WasteReportRecord[]>();
    for (const report of actionableReports) {
      const reports = groupedActionable.get(report.category) ?? [];
      reports.push(report);
      groupedActionable.set(report.category, reports);
    }

    return [
      ...[...groupedActionable.entries()].map(([category, reports]) => ({
        id: `${category}-${reports[0]?.id ?? "report"}`,
        tone: "warning" as const,
        text: formatWasteSummaryGroup(category, reports),
      })),
      ...modelInsights.map((report) => ({
        id: report.id,
        tone: "info" as const,
        text: formatWasteSummary(report),
      })),
    ];
  }, [actionableReports, modelInsights]);

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

  const visibleTimeline = timeline.slice(0, visibleCalls);

  return (
    <div className="detail-shell px-4 py-4">
      <div className="panel overflow-hidden px-0 py-2">
        <div className="timeline-log">
          {wasteSegments.length > 0 ? (
            <div className="timeline-line border-b border-[color:var(--border)] px-4">
              <div className="timeline-summary">
                {wasteSegments.map((segment) => (
                  <span
                    key={segment.id}
                    className={`timeline-summary__item ${
                      segment.tone === "warning"
                        ? "timeline-summary__item--warning"
                        : "timeline-summary__item--info"
                    }`}
                  >
                    {segment.tone === "warning" ? "⚠" : "ℹ"} {segment.text}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {visibleTimeline.map(({ index, span, tools }) => (
            <div key={span.id}>
              <div className="timeline-line timeline-line--llm px-4">
                <span className="timeline-line__index">#{index}</span>
                <span className="timeline-line__type">LLM</span>
                <span className="timeline-line__model">{span.model ?? "unknown"}</span>
                <span className="timeline-line__metric">
                  in:{formatCompactInt(span.inputTokens ?? 0)}
                </span>
                <span className="timeline-line__metric">
                  out:{formatCompactInt(span.outputTokens ?? 0)}
                </span>
                <span className="timeline-line__cost">{formatUsd(span.costUsd ?? 0)}</span>
                <span
                  className={`timeline-line__status ${
                    span.status === "error"
                      ? "timeline-line__status--error"
                      : "timeline-line__status--ok"
                  }`}
                >
                  {timelineStatusLabel(span.status)}
                </span>
              </div>

              {tools.map((toolSpan, toolIndex) => (
                <div key={toolSpan.id} className="timeline-line timeline-line--tool px-4">
                  <span className="timeline-line__tree">
                    {toolIndex === tools.length - 1 ? "└──" : "├──"}
                  </span>
                  <span className="timeline-line__tool-name">{toolSpan.toolName ?? "tool"}</span>
                  <span className="timeline-line__tool-arg">{getToolPreview(toolSpan)}</span>
                  <span
                    className={`timeline-line__status ${
                      toolSpan.status === "error"
                        ? "timeline-line__status--error"
                        : "timeline-line__status--ok"
                    }`}
                  >
                    {toolSpan.status === "error" ? "✗ error" : "ok"}
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div className="timeline-line timeline-line--footer border-t border-[color:var(--border)] px-4">
            <span className="timeline-line__footer-copy">
              {visibleTimeline.length} of {timeline.length} LLM calls
            </span>

            <div className="flex items-center gap-3">
              {timeline.length > visibleCalls ? (
                <button
                  type="button"
                  onClick={() => setVisibleCalls((current) => current + INITIAL_VISIBLE_LLM_CALLS)}
                  className="button-ghost px-2 py-1 text-xs"
                >
                  Load more
                </button>
              ) : null}

              <button
                type="button"
                onClick={onViewTrace}
                className="button-ghost px-2 py-1 text-xs"
              >
                View all →
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
