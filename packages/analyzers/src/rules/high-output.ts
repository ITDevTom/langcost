import type { WasteReportRecord } from "@langcost/db";

import { createWasteReport, getOutputCostUsd, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

export const highOutputRule: WasteRule = {
  name: "high-output",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const reports: WasteReportRecord[] = [];

      for (const span of context.llmSpans) {
        const peerSpans = context.llmSpans.filter((candidate) => candidate.id !== span.id);
        if (peerSpans.length === 0 || !span.outputTokens || span.outputTokens < 100) {
          continue;
        }

        const peerAverage =
          peerSpans.reduce((total, candidate) => total + (candidate.outputTokens ?? 0), 0) /
          peerSpans.length;

        if (peerAverage === 0 || span.outputTokens <= peerAverage * 3) {
          continue;
        }

        const excessTokens = span.outputTokens - peerAverage;
        const outputCostPerToken = getOutputCostUsd(span) / Math.max(1, span.outputTokens);
        const wastedCostUsd = excessTokens * outputCostPerToken;

        reports.push(
          createWasteReport({
            traceId: context.trace.id,
            spanId: span.id,
            category: "high_output",
            severity: severityFromCost(wastedCostUsd),
            wastedTokens: excessTokens,
            wastedCostUsd,
            description: `Span ${span.id} produced ${span.outputTokens} output tokens, more than 3x the peer average of ${peerAverage.toFixed(1)}.`,
            recommendation:
              "Consider stricter max token limits or more concise prompting for verbose turns.",
            evidence: {
              outputTokens: span.outputTokens,
              peerAverage,
            },
          }),
        );
      }

      return reports;
    });
  },
};
