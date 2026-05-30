import type { SegmentType } from "@langcost/core";
import type { WasteReportRecord } from "@langcost/db";

import { createWasteReport, severityFromCost } from "./shared";
import type { ResolvedRuleConfig, WasteRule } from "./types";

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid];
  if (midValue === undefined) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return midValue;
  }

  const prev = sorted[mid - 1];
  if (prev === undefined) {
    return midValue;
  }
  return (prev + midValue) / 2;
}

export const oversizedContextRule: WasteRule = {
  id: "oversized-context",
  tier: 1,
  title: "Oversized context",
  description: "LLM turns with unusually large input context compared to trace baseline.",
  defaultEnabled: true,
  defaultThresholds: {
    minInputTokens: 50_000,
    medianMultiplier: 3,
  },
  detect(contexts, config?: ResolvedRuleConfig): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      if (context.llmSpans.length === 0) {
        return [];
      }

      const minInputTokens = Math.max(0, config?.thresholds.minInputTokens ?? 50_000);
      const medianMultiplier = Math.max(1, config?.thresholds.medianMultiplier ?? 3);
      const traceMedianInput = median(context.llmSpans.map((span) => span.inputTokens ?? 0));

      const reports: WasteReportRecord[] = [];
      for (const span of context.llmSpans) {
        const inputTokens = span.inputTokens ?? 0;
        if (inputTokens <= 0) {
          continue;
        }

        const relativeThreshold = traceMedianInput * medianMultiplier;
        const triggeredByAbsolute = inputTokens >= minInputTokens;
        const triggeredByRelative = traceMedianInput > 0 && inputTokens >= relativeThreshold;
        if (!triggeredByAbsolute && !triggeredByRelative) {
          continue;
        }

        const baseline =
          triggeredByAbsolute && triggeredByRelative
            ? Math.max(minInputTokens, relativeThreshold)
            : triggeredByAbsolute
              ? minInputTokens
              : relativeThreshold;
        const excessTokens = Math.max(0, inputTokens - baseline);
        const wastedCostUsd = span.costUsd ? span.costUsd * (excessTokens / inputTokens) : 0;

        const segmentTotalsByType = new Map<SegmentType, number>();
        for (const segment of context.segments) {
          if (segment.spanId !== span.id) {
            continue;
          }
          segmentTotalsByType.set(
            segment.type,
            (segmentTotalsByType.get(segment.type) ?? 0) + segment.tokenCount,
          );
        }

        const dominantSegments = [...segmentTotalsByType.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([type, tokenCount]) => ({ type, tokenCount }));

        reports.push(
          createWasteReport({
            traceId: context.trace.id,
            spanId: span.id,
            category: "oversized_context",
            severity: severityFromCost(wastedCostUsd),
            wastedTokens: excessTokens,
            wastedCostUsd,
            description: `Span ${span.id} used ${inputTokens.toLocaleString()} input tokens, exceeding oversized-context thresholds for this trace.`,
            recommendation:
              "Summarize old history, trim stale tool results, reduce RAG payload size, or split work into smaller turns.",
            evidence: {
              inputTokens,
              traceMedianInputTokens: traceMedianInput,
              thresholds: {
                minInputTokens,
                medianMultiplier,
                relativeThreshold,
              },
              triggeredBy: {
                absolute: triggeredByAbsolute,
                relativeToMedian: triggeredByRelative,
              },
              dominantSegmentTypes: dominantSegments,
              segmentTokenTotalsByType: Object.fromEntries(segmentTotalsByType.entries()),
              estimatedExcessTokens: excessTokens,
            },
          }),
        );
      }

      return reports;
    });
  },
};
