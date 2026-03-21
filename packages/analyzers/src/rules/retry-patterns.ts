import type { WasteReportRecord } from "@langcost/db";

import { getSpanCost, getSpanTotalTokens } from "../context";
import { createWasteReport, jaccardSimilarity, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

export const retryPatternsRule: WasteRule = {
  name: "retry-patterns",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const userMessages = context.messages.filter((message) => message.role === "user");
      const retrySpanIds = new Set<string>();
      let retryCount = 0;

      for (let index = 1; index < userMessages.length; index += 1) {
        const previous = userMessages[index - 1];
        const current = userMessages[index];
        if (!previous || !current) {
          continue;
        }

        const similarity = jaccardSimilarity(previous.content, current.content);

        if (similarity > 0.7) {
          retryCount += 1;
          retrySpanIds.add(current.spanId);
        }
      }

      if (retryCount === 0) {
        return [];
      }

      const spansById = new Map(context.spans.map((span) => [span.id, span]));
      const retrySpans = [...retrySpanIds]
        .map((spanId) => spansById.get(spanId))
        .filter((span): span is NonNullable<typeof span> => span !== undefined);

      const wastedCostUsd = retrySpans.reduce((total, span) => total + getSpanCost(span), 0);
      const wastedTokens = retrySpans.reduce((total, span) => total + getSpanTotalTokens(span), 0);
      const firstRetrySpan = retrySpans[0];

      return [
        createWasteReport({
          traceId: context.trace.id,
          ...(firstRetrySpan ? { spanId: firstRetrySpan.id } : {}),
          category: "retry_waste",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `Detected ${retryCount} sequential retry prompt(s) with near-duplicate wording.`,
          recommendation: `Investigate why the earlier answer failed. Retries in this trace cost about $${wastedCostUsd.toFixed(4)}.`,
          evidence: {
            retrySpanIds: retrySpans.map((span) => span.id),
            retryCount,
          },
        }),
      ];
    });
  },
};
