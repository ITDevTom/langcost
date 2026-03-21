import type { MessageRecord, SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

function compareDates(left: Date | null | undefined, right: Date | null | undefined): number {
  return (left?.getTime() ?? 0) - (right?.getTime() ?? 0);
}

export interface TraceAnalysisContext {
  trace: TraceRecord;
  spans: SpanRecord[];
  messages: MessageRecord[];
  segments: SegmentRecord[];
  llmSpans: SpanRecord[];
  toolSpans: SpanRecord[];
}

export function buildTraceContext(
  trace: TraceRecord,
  spans: SpanRecord[],
  messages: MessageRecord[],
  segments: SegmentRecord[],
): TraceAnalysisContext {
  const orderedSpans = [...spans].sort((left, right) => {
    const dateDelta = compareDates(left.startedAt, right.startedAt);
    return dateDelta !== 0 ? dateDelta : left.id.localeCompare(right.id);
  });

  return {
    trace,
    spans: orderedSpans,
    messages,
    segments: [...segments],
    llmSpans: orderedSpans.filter((span) => span.type === "llm"),
    toolSpans: orderedSpans.filter((span) => span.type === "tool"),
  };
}

export function getSpanTotalTokens(span: SpanRecord): number {
  return (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
}

export function getSpanCost(span: SpanRecord): number {
  return span.costUsd ?? 0;
}

export function getNumericMetadataValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
