import type { WasteReportRecord } from "@langcost/db";

import { getSpanCost, getSpanTotalTokens } from "../context";
import { createWasteReport, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

export const toolFailuresRule: WasteRule = {
  name: "tool-failures",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const failedToolSpans = context.toolSpans.filter(
        (span) => span.status === "error" || span.toolSuccess === false,
      );

      if (failedToolSpans.length === 0) {
        return [];
      }

      const spansById = new Map(context.spans.map((span) => [span.id, span]));
      const failedParentSpans = failedToolSpans
        .map((span) => (span.parentSpanId ? spansById.get(span.parentSpanId) : undefined))
        .filter((span): span is NonNullable<typeof span> => span !== undefined);

      const retryLlmSpanIds = new Set<string>();
      for (const failedToolSpan of failedToolSpans) {
        const nextLlmSpan = context.llmSpans.find(
          (span) =>
            span.startedAt.getTime() > failedToolSpan.startedAt.getTime() &&
            span.id !== failedToolSpan.parentSpanId,
        );

        if (nextLlmSpan) {
          retryLlmSpanIds.add(nextLlmSpan.id);
        }
      }

      const retryLlmSpans = [...retryLlmSpanIds]
        .map((spanId) => spansById.get(spanId))
        .filter((span): span is NonNullable<typeof span> => span !== undefined);

      const wastedSpans = [...failedParentSpans, ...retryLlmSpans];
      const wastedCostUsd = wastedSpans.reduce((total, span) => total + getSpanCost(span), 0);
      const wastedTokens = wastedSpans.reduce((total, span) => total + getSpanTotalTokens(span), 0);
      const firstFailedToolSpan = failedToolSpans[0];

      return [
        createWasteReport({
          traceId: context.trace.id,
          ...(firstFailedToolSpan ? { spanId: firstFailedToolSpan.id } : {}),
          category: "tool_failure_waste",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `${failedToolSpans.length} tool call(s) failed and triggered additional model work in this trace.`,
          recommendation: `Inspect the failing tool paths and error handling. These failures cost about $${wastedCostUsd.toFixed(4)} in this trace.`,
          evidence: {
            failedToolSpanIds: failedToolSpans.map((span) => span.id),
            retryLlmSpanIds: retryLlmSpans.map((span) => span.id),
          },
        }),
      ];
    });
  },
};
