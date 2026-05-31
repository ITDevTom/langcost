import type { FaultConfidence, FaultType, Severity } from "@langcost/core";
import type { FaultReportRecord, SpanRecord } from "@langcost/db";

export interface FaultReportDraft {
  traceId: string;
  faultSpanId: string;
  rootCauseSpanId?: string | null;
  faultType: FaultType;
  severity: Severity;
  confidence: FaultConfidence;
  description: string;
  recommendation: string;
  cascadeDepth: number;
  affectedSpanIds: string[];
}

export function createFaultReport(draft: FaultReportDraft): FaultReportRecord {
  return {
    id: crypto.randomUUID(),
    traceId: draft.traceId,
    faultSpanId: draft.faultSpanId,
    rootCauseSpanId: draft.rootCauseSpanId ?? null,
    faultType: draft.faultType,
    severity: draft.severity,
    confidence: draft.confidence,
    description: draft.description,
    recommendation: draft.recommendation,
    cascadeDepth: draft.cascadeDepth,
    affectedSpanIds: draft.affectedSpanIds,
    detectedAt: new Date(),
  };
}

export function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** A hard failure signal on first-class columns — the high-confidence fault input. */
export function isErrorSpan(span: SpanRecord): boolean {
  return span.status === "error" || span.toolSuccess === false || nonEmpty(span.errorMessage);
}

/**
 * Classify the fault from the error text so the `fault_type` enum is exercised beyond
 * `tool_failure` — rate-limit/context-length -> model_error, timeout/deadline -> timeout, a failing
 * retrieval -> upstream_data, otherwise tool_failure.
 */
export function classifyFaultType(
  errorMessage: string | null | undefined,
  spanType: SpanRecord["type"],
): FaultType {
  const text = (errorMessage ?? "").toLowerCase();
  if (/(\b429\b|rate.?limit|quota|context.?length|\b413\b|token limit)/.test(text)) {
    return "model_error";
  }
  if (/(timeout|timed out|deadline|\b504\b|etimedout)/.test(text)) {
    return "timeout";
  }
  if (spanType === "retrieval") {
    return "upstream_data";
  }
  return "tool_failure";
}
