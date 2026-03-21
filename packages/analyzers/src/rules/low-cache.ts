import { findPricing } from "@langcost/core";
import type { WasteReportRecord } from "@langcost/db";

import { getNumericMetadataValue } from "../context";
import { createWasteReport, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

export const lowCacheRule: WasteRule = {
  name: "low-cache",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const eligibleSpans = context.llmSpans
        .map((span) => {
          const pricing = span.model ? findPricing(span.model) : undefined;
          const cacheRead = getNumericMetadataValue(span.metadata, "cacheRead");

          if (!pricing?.cachedInputPricePerMToken || !span.inputTokens || cacheRead === undefined) {
            return undefined;
          }

          const ratio = cacheRead / Math.max(1, span.inputTokens);
          if (ratio >= 0.1) {
            return undefined;
          }

          const potentialSavings =
            (span.inputTokens / 1_000_000) *
            (pricing.inputPricePerMToken - pricing.cachedInputPricePerMToken);

          return {
            span,
            ratio,
            potentialSavings,
          };
        })
        .filter((value) => value !== undefined);

      if (eligibleSpans.length === 0) {
        return [];
      }

      const averageRatio =
        eligibleSpans.reduce((total, entry) => total + entry.ratio, 0) / eligibleSpans.length;
      const totalSavings = eligibleSpans.reduce(
        (total, entry) => total + entry.potentialSavings,
        0,
      );

      return [
        createWasteReport({
          traceId: context.trace.id,
          category: "low_cache_utilization",
          severity: severityFromCost(totalSavings),
          wastedTokens: eligibleSpans.reduce(
            (total, entry) => total + (entry.span.inputTokens ?? 0),
            0,
          ),
          wastedCostUsd: totalSavings,
          estimatedSavingsUsd: totalSavings,
          description: `Prompt caching usage stayed below 10% across ${eligibleSpans.length} LLM span(s) in this trace.`,
          recommendation: `Enable prompt caching. This trace left about $${totalSavings.toFixed(4)} in savings on the table.`,
          evidence: {
            averageCacheReadRatio: averageRatio,
            spanIds: eligibleSpans.map((entry) => entry.span.id),
          },
        }),
      ];
    });
  },
};
