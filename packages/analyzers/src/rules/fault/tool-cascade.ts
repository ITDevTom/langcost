import type { FaultReportRecord, SpanRecord } from "@langcost/db";

import type { TraceAnalysisContext } from "../../context";
import { getCommandFirstToken, RETRY_WINDOW_MS } from "../shared";
import { classifyFaultType, createFaultReport, isErrorSpan, nonEmpty } from "./shared";
import type { FaultRule } from "./types";

/**
 * A failed tool span is "recovered" (and therefore inefficiency, not a terminal fault) if a later
 * same-tool call succeeded within the retry window. Reuses the battle-tested first-token matcher
 * from the tool-failure waste rule rather than full-input equality, so "npm test" matches
 * "npm test 2>&1" but not an unrelated Bash call. Only tool spans can recover this way.
 */
function isRecovered(failed: SpanRecord, toolSpans: SpanRecord[]): boolean {
  // Only a named tool can be matched to a later retry. A failure on a tool we can't identify
  // (null toolName) must NOT be auto-recovered — suppressing a fault we're unsure about is the
  // dangerous direction for a fault engine (false negative), so leave it live.
  if (failed.type !== "tool" || !failed.toolName) {
    return false;
  }
  const failedAt = failed.startedAt.getTime();
  const failedToken = getCommandFirstToken(failed.toolInput);
  return toolSpans.some((candidate) => {
    if (candidate.id === failed.id || candidate.toolName !== failed.toolName) return false;
    const startedAt = candidate.startedAt.getTime();
    if (startedAt <= failedAt || startedAt - failedAt > RETRY_WINDOW_MS) return false;
    if (candidate.status !== "ok" || candidate.toolSuccess === false) return false; // not a success
    if (failedToken !== null) {
      return getCommandFirstToken(candidate.toolInput) === failedToken;
    }
    return true;
  });
}

// Lower = more likely the true origin. Prefer a tool/retrieval span (where a concrete failure
// happens) over an llm/agent that merely surfaced it, and prefer a span carrying an errorMessage.
// This is the sibling-aware tie-break: an llm that errors after its sibling tools loses to the
// earlier tool even though it isn't the llm's child.
function originScore(span: SpanRecord): number {
  const isLeafFailure = span.type === "tool" || span.type === "retrieval";
  return (isLeafFailure ? 0 : 2) + (nonEmpty(span.errorMessage) ? 0 : 1);
}

export const toolCascadeRule: FaultRule = {
  id: "fault-tool-cascade",
  title: "Tool / API failure cascade",
  description:
    "An unrecovered tool or model error, attributed to the first failing span and the cascade it caused.",
  defaultEnabled: true,
  requires: ["spans"],

  detect(contexts: TraceAnalysisContext[]): FaultReportRecord[] {
    const reports: FaultReportRecord[] = [];

    for (const context of contexts) {
      const errors = context.spans.filter(isErrorSpan);
      if (errors.length === 0) {
        continue; // clean trace -> stays quiet
      }

      // Drop failures that later succeeded on retry — those are waste (the cost engine's job),
      // not a terminal fault.
      const live = errors.filter((span) => !isRecovered(span, context.toolSpans));
      if (live.length === 0) {
        continue;
      }

      // Precision gate: rule #1 scopes to HARD failures — traces the source marked as failed. A
      // COMPLETED trace is not a terminal fault no matter how many incidental tool errors it had
      // (a `grep -c` exit 1, a locally-recovered call). Silent faults in completed traces are the
      // job of rule #2 (corrupt tool output) and rule #4 (empty-retrieval hallucination).
      if (context.trace.status !== "error") {
        continue;
      }

      // Root cause = first-failing origin: earliest start, tie-broken toward a leaf tool/retrieval
      // failure with a concrete message.
      const root = [...live].sort((a, b) => {
        const byTime = a.startedAt.getTime() - b.startedAt.getTime();
        return byTime !== 0 ? byTime : originScore(a) - originScore(b);
      })[0] as SpanRecord;

      // Fault span = the last error in the chain (the visible symptom that set trace.status).
      const fault = [...live].sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
      )[0] as SpanRecord;

      const affectedSpanIds = live.map((span) => span.id);
      const faultType = classifyFaultType(root.errorMessage, root.type);
      const rootLabel = root.toolName ?? root.name ?? root.type;
      const rootMessage = nonEmpty(root.errorMessage)
        ? ` ("${root.errorMessage?.slice(0, 120)}")`
        : "";
      const verb = faultType === "timeout" ? "timed out" : "failed";

      const recommendation =
        faultType === "model_error"
          ? "Handle the provider error (rate-limit / context-length): back off, shrink the prompt, or route to a fallback model. The root cause is the first failing call, not the downstream symptom."
          : faultType === "timeout"
            ? "Add a timeout budget + circuit breaker with a fast-fail path. The root cause is the first timeout, not the downstream symptom."
            : `Add error handling / a circuit breaker around ${rootLabel} (fail fast after repeated errors) and validate its output before the next step. The root cause is the first failing call, not the downstream symptom.`;

      reports.push(
        createFaultReport({
          traceId: context.trace.id,
          faultSpanId: fault.id,
          rootCauseSpanId: root.id,
          faultType,
          // High confidence: every signal here is a first-class status/errorMessage column.
          confidence: "high",
          // Only failed traces reach here, so this is a terminal fault.
          severity: "critical",
          description: `${rootLabel} ${verb}${rootMessage} and originated a ${affectedSpanIds.length}-span failure cascade; the run ended in error.`,
          recommendation,
          cascadeDepth: affectedSpanIds.length,
          affectedSpanIds,
        }),
      );
    }

    return reports;
  },
};
