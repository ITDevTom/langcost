import type { FaultReportRecord, SpanRecord } from "@langcost/db";

import type { TraceAnalysisContext } from "../../context";
import { getCommandFirstToken, RETRY_WINDOW_MS } from "../shared";
import { createFaultReport, isErrorSpan } from "./shared";
import type { FaultRule } from "./types";

/**
 * Tool output that *looks* like success at the status layer but carries no usable payload:
 * null/empty/whitespace, or a trimmed value that is an empty container / error-shaped sentinel
 * ({}, [], null, none, "not found", "no results", "empty", "undefined", …).
 *
 * Deliberately conservative — we must NOT flag legitimate short outputs like "ok", "done", "0",
 * "true". A false positive here points the operator at a healthy tool, so the bar is "this string
 * is essentially the absence of an answer", not "this string is short".
 */
export function isCorruptToolOutput(toolOutput: string | null): boolean {
  if (toolOutput === null) {
    return true;
  }
  const trimmed = toolOutput.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "{}" || lowered === "[]" || lowered === "null" || lowered === "none") {
    return true;
  }
  return /^("?)(not found|no results?|no matches?|empty|undefined)\1$/i.test(trimmed);
}

/**
 * A silent corrupt-output tool only matters if the agent *acted on* the bad data. We accept two
 * downstream consequences:
 *   (a) a later span (strictly after this tool) that errored — the agent consumed the junk and
 *       something downstream blew up; or
 *   (b) the same tool was immediately retried within the window — a weaker signal that the agent
 *       noticed the output was useless and tried again.
 * No consequence => the empty result was harmless or handled, so we stay quiet (precision).
 */
function findDownstreamErrors(tool: SpanRecord, spans: SpanRecord[]): SpanRecord[] {
  const toolAt = tool.startedAt.getTime();
  return spans.filter((span) => span.startedAt.getTime() > toolAt && isErrorSpan(span));
}

function wasImmediatelyRetried(tool: SpanRecord, toolSpans: SpanRecord[]): boolean {
  if (!tool.toolName) {
    return false;
  }
  const toolAt = tool.startedAt.getTime();
  const toolToken = getCommandFirstToken(tool.toolInput);
  return toolSpans.some((candidate) => {
    if (candidate.id === tool.id || candidate.toolName !== tool.toolName) {
      return false;
    }
    const startedAt = candidate.startedAt.getTime();
    if (startedAt <= toolAt || startedAt - toolAt > RETRY_WINDOW_MS) {
      return false;
    }
    // For shell tools the first command token must match so "git status" doesn't pair with an
    // unrelated "git push" issued on the same Bash tool.
    if (toolToken !== null) {
      return getCommandFirstToken(candidate.toolInput) === toolToken;
    }
    return true;
  });
}

export const silentToolMisuseRule: FaultRule = {
  id: "fault-silent-tool-misuse",
  title: "Silent tool misuse / corrupt output",
  description:
    "A tool reported success but returned empty/error-shaped output that the agent acted on, " +
    "attributed across the silent ok→error boundary that status-based monitoring misses.",
  defaultEnabled: true,
  requires: ["spans"],

  detect(contexts: TraceAnalysisContext[]): FaultReportRecord[] {
    const reports: FaultReportRecord[] = [];

    for (const context of contexts) {
      // Candidate = a tool span the source marked as SUCCESS but whose payload is junk. The
      // status/toolSuccess guards exclude hard failures by construction, so rule #1's territory
      // (terminal errors) is never double-counted here.
      const candidates = context.spans.filter(
        (span) =>
          span.type === "tool" &&
          span.status === "ok" &&
          span.toolSuccess !== false &&
          isCorruptToolOutput(span.toolOutput ?? null),
      );

      for (const tool of candidates) {
        const downstreamErrors = findDownstreamErrors(tool, context.spans);
        const hasDownstreamError = downstreamErrors.length > 0;
        const retried = !hasDownstreamError && wasImmediatelyRetried(tool, context.toolSpans);

        // No downstream consequence => harmless/handled empty result. Stay quiet.
        if (!hasDownstreamError && !retried) {
          continue;
        }

        const toolName = tool.toolName ?? tool.name ?? tool.type;
        // rootCause = the silent tool (the upstream origin across the ok->error boundary).
        // faultSpan = the downstream errored span when one exists, else the tool itself.
        const faultSpanId = hasDownstreamError ? (downstreamErrors[0]?.id ?? tool.id) : tool.id;
        const affectedSpanIds = [tool.id, ...downstreamErrors.map((span) => span.id)];

        const description = hasDownstreamError
          ? `${toolName} reported success but returned empty/invalid output, and a downstream step failed; the agent acted on bad data.`
          : `${toolName} reported success but returned empty/invalid output and was immediately retried; the agent could not act on bad data.`;

        reports.push(
          createFaultReport({
            traceId: context.trace.id,
            faultSpanId,
            rootCauseSpanId: tool.id,
            faultType: "upstream_data",
            // High only when a real downstream ERROR confirms the bad data caused damage; a retry
            // alone is a softer heuristic, so cap it at medium.
            confidence: hasDownstreamError ? "high" : "medium",
            severity: hasDownstreamError ? "high" : "medium",
            description,
            recommendation:
              "Validate tool output before consuming it (treat empty/error-shaped results as failures); the root cause is the silent tool, not the downstream symptom.",
            cascadeDepth: affectedSpanIds.length,
            affectedSpanIds,
          }),
        );
      }
    }

    return reports;
  },
};
