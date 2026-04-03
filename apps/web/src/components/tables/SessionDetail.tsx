import { useMemo, useState } from "react";

import type { MessageRecord, SpanRecord, TraceDetailResponse, WasteReportRecord } from "../../api/client";
import { formatCompactInt, formatUsd } from "../../lib/format";

interface SessionDetailProps {
  detail: TraceDetailResponse | null;
  loading: boolean;
  onViewTrace: () => void;
}

const INITIAL_VISIBLE_LLM_CALLS = 5;

function isInformational(report: WasteReportRecord): boolean {
  return report.category === "model_overuse" || report.category === "cache_expiry";
}

function truncateText(value: string, maxLength = 72): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function getAssistantPreview(messages: MessageRecord[], spanId: string, maxLength = 120): string | null {
  const assistantMsg = messages.find((m) => m.spanId === spanId && m.role === "assistant");
  if (!assistantMsg?.content) return null;
  // Strip markdown headers, tool blocks, and collapse whitespace
  const cleaned = assistantMsg.content
    .replace(/\[tool:[^\]]*\][^\n]*/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\n{2,}/g, " | ")
    .replace(/\n/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return truncateText(cleaned, maxLength);
}

function getToolSummary(span: SpanRecord): string {
  const name = span.toolName ?? "tool";
  const rawInput = span.toolInput?.trim();
  if (!rawInput) {
    if (span.toolOutput) return truncateText(span.toolOutput, 80);
    return "";
  }

  try {
    const parsed = JSON.parse(rawInput) as Record<string, unknown>;

    // For Edit: show file path + what changed
    if (name === "Edit" || name === "Write") {
      const file = parsed.file_path ?? parsed.filePath;
      if (typeof file === "string") {
        const shortFile = file.split("/").slice(-2).join("/");
        return shortFile;
      }
    }

    // For Bash: show command
    if (name === "Bash") {
      const cmd = parsed.command ?? parsed.cmd;
      if (typeof cmd === "string") return truncateText(cmd, 80);
    }

    // For Read/Glob/Grep: show path or pattern
    for (const key of ["file_path", "filePath", "path", "pattern", "query", "url", "prompt", "description"]) {
      const val = parsed[key];
      if (typeof val === "string" && val.length > 0) return truncateText(val, 80);
    }

    // For Agent: show description
    if (name === "Agent") {
      const desc = parsed.description;
      if (typeof desc === "string") return truncateText(desc, 80);
    }
  } catch {}

  return truncateText(rawInput, 60);
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
    case "cache_expiry": {
      const gapMin = getNumberEvidence(report, "gapMinutes") ?? 0;
      const writeK = Math.round((getNumberEvidence(report, "cacheWriteTokens") ?? 0) / 1000);
      return `${gapMin}min idle → ${writeK}K tokens re-cached`;
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
    case "cache_expiry": {
      const totalWriteK = reports.reduce(
        (total, report) => total + (getNumberEvidence(report, "cacheWriteTokens") ?? 0),
        0,
      );
      return `${pluralize(reports.length, "cache expiry")} (${(totalWriteK / 1000).toFixed(0)}K re-cached)`;
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

function categoryToFilter(category: string): FilterMode | null {
  switch (category) {
    case "high_output": return "verbose";
    case "tool_failure_waste": return "tool_failures";
    case "retry_waste": return "retries";
    case "agent_loop": return "agent_loops";
    default: return null;
  }
}

type FilterMode = "all" | "verbose" | "tool_failures" | "retries" | "agent_loops";

export function SessionDetail({ detail, loading, onViewTrace }: SessionDetailProps) {
  const [visibleCalls, setVisibleCalls] = useState(INITIAL_VISIBLE_LLM_CALLS);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const actionableReports = useMemo(
    () => detail?.wasteReports.filter((report) => !isInformational(report)) ?? [],
    [detail],
  );
  const informationalReports = useMemo(() => detail?.wasteReports.filter(isInformational) ?? [], [detail]);
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
        filter: categoryToFilter(category),
      })),
      ...informationalReports.map((report) => ({
        id: report.id,
        tone: "info" as const,
        text: formatWasteSummary(report),
        filter: null as FilterMode | null,
      })),
    ];
  }, [actionableReports, informationalReports]);

  // Collect span IDs for each waste category
  const wasteSpanIds = useMemo(() => {
    const verbose = new Set<string>();
    const toolFailures = new Set<string>();
    const retries = new Set<string>();
    const agentLoops = new Set<string>();

    for (const report of detail?.wasteReports ?? []) {
      const spanId = report.spanId;
      switch (report.category) {
        case "high_output":
          if (spanId) verbose.add(spanId);
          break;
        case "tool_failure_waste": {
          const failedIds = report.evidence.failedToolSpanIds;
          if (Array.isArray(failedIds)) {
            for (const id of failedIds) if (typeof id === "string") toolFailures.add(id);
          }
          break;
        }
        case "retry_waste":
          if (spanId) retries.add(spanId);
          break;
        case "agent_loop": {
          const repeatedIds = report.evidence.repeatedToolSpanIds;
          if (Array.isArray(repeatedIds)) {
            for (const id of repeatedIds) if (typeof id === "string") agentLoops.add(id);
          }
          break;
        }
      }
    }

    return { verbose, toolFailures, retries, agentLoops };
  }, [detail]);

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

  // Filter timeline based on active filter mode — must be before early returns
  const filteredTimeline = useMemo(() => {
    if (filterMode === "all") return timeline;

    const relevantSpanIds =
      filterMode === "verbose" ? wasteSpanIds.verbose
      : filterMode === "tool_failures" ? wasteSpanIds.toolFailures
      : filterMode === "retries" ? wasteSpanIds.retries
      : wasteSpanIds.agentLoops;

    return timeline.filter(({ span, tools }) => {
      if (relevantSpanIds.has(span.id)) return true;
      if (tools.some((t) => relevantSpanIds.has(t.id))) return true;
      return false;
    });
  }, [timeline, filterMode, wasteSpanIds]);

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

  const visibleTimeline = filteredTimeline.slice(0, visibleCalls);

  return (
    <div className="detail-shell px-4 py-4">
      <div className="panel overflow-hidden px-0 py-2">
        <div className="timeline-log">
          {wasteSegments.length > 0 ? (
            <div className="timeline-line border-b border-[color:var(--border)] px-4">
              <div className="timeline-summary">
                {wasteSegments.map((segment) => {
                  const isClickable = segment.filter !== null;
                  const isActive = segment.filter !== null && filterMode === segment.filter;
                  return (
                    <button
                      key={segment.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isClickable) return;
                        setFilterMode(isActive ? "all" : segment.filter!);
                        setVisibleCalls(INITIAL_VISIBLE_LLM_CALLS);
                      }}
                      className={`timeline-summary__item ${
                        segment.tone === "warning"
                          ? "timeline-summary__item--warning"
                          : "timeline-summary__item--info"
                      } ${isClickable ? "cursor-pointer hover:opacity-80" : ""} ${
                        isActive ? "ring-1 ring-white/30 rounded-md" : ""
                      }`}
                      style={{ background: "none", border: "none", padding: "2px 6px" }}
                    >
                      {segment.tone === "warning" ? "⚠" : "ℹ"} {segment.text}
                    </button>
                  );
                })}
                {filterMode !== "all" ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilterMode("all");
                      setVisibleCalls(INITIAL_VISIBLE_LLM_CALLS);
                    }}
                    className="text-xs text-slate-400 hover:text-slate-200 ml-2"
                    style={{ background: "none", border: "none" }}
                  >
                    show all
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {filterMode !== "all" && filteredTimeline.length === 0 ? (
            <div className="timeline-line px-4 text-sm text-slate-500">
              No matching spans found for this filter.{" "}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFilterMode("all"); }}
                className="text-slate-300 underline"
                style={{ background: "none", border: "none" }}
              >
                Show all
              </button>
            </div>
          ) : null}

          {visibleTimeline.map(({ index, span, tools }) => {
            // When filtering by tool_failures, only show the failed tools
            const visibleTools = filterMode === "tool_failures"
              ? tools.filter((t) => t.status === "error")
              : tools;

            return (
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

                {filterMode !== "all" && detail?.messages ? (() => {
                  const preview = getAssistantPreview(detail.messages, span.id);
                  return preview ? (
                    <div className="timeline-line timeline-line--tool px-4" style={{ paddingLeft: "4.5rem" }}>
                      <span className="text-slate-400 text-xs leading-5" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                        {preview}
                      </span>
                    </div>
                  ) : null;
                })() : null}

                {visibleTools.map((toolSpan, toolIndex) => (
                  <div key={toolSpan.id} className="timeline-line timeline-line--tool px-4">
                    <span className="timeline-line__tree">
                      {toolIndex === visibleTools.length - 1 ? "└──" : "├──"}
                    </span>
                    <span className="timeline-line__tool-name">{toolSpan.toolName ?? "tool"}</span>
                    <span className="timeline-line__tool-arg">{getToolSummary(toolSpan)}</span>
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
            );
          })}

          <div className="timeline-line timeline-line--footer border-t border-[color:var(--border)] px-4">
            <span className="timeline-line__footer-copy">
              {visibleTimeline.length} of {filteredTimeline.length} LLM calls
              {filterMode !== "all" ? ` (filtered)` : ""}
            </span>

            <div className="flex items-center gap-3">
              {filteredTimeline.length > visibleCalls ? (
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
