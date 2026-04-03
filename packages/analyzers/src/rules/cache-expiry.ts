import type { WasteReportRecord } from "@langcost/db";

import { getNumericMetadataValue } from "../context";
import { createWasteReport, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_CACHE_WRITE_TOKENS = 10_000; // Only flag if significant cache write

export const cacheExpiryRule: WasteRule = {
  name: "cache-expiry",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const reports: WasteReportRecord[] = [];
      const llmSpans = context.llmSpans;

      if (llmSpans.length < 2) {
        return [];
      }

      for (let i = 1; i < llmSpans.length; i++) {
        const prev = llmSpans[i - 1];
        const curr = llmSpans[i];

        if (!prev || !curr) continue;

        const gapMs = curr.startedAt.getTime() - prev.startedAt.getTime();
        if (gapMs < CACHE_TTL_MS) {
          continue;
        }

        // Check if this span had a large cache write (indicating cache miss / expiry)
        const cacheWriteTokens =
          getNumericMetadataValue(curr.metadata, "cacheCreationTokens") ?? 0;

        if (cacheWriteTokens < MIN_CACHE_WRITE_TOKENS) {
          continue;
        }

        // Estimate the extra cost: cache write price - cache read price for those tokens
        // At Opus 4.6: write=$10/M, read=$0.50/M → delta=$9.50/M
        // We approximate using a 19x multiplier (write/read ratio)
        const cacheReadTokens =
          getNumericMetadataValue(curr.metadata, "cacheReadTokens") ?? 0;
        const totalContextTokens = cacheWriteTokens + cacheReadTokens;

        // The waste is the difference: what was paid (write) vs what could have been (read)
        // write price ≈ 20x read price, so excess ≈ 19/20 of the write cost
        // Use a conservative estimate based on the span's actual cost ratio
        const spanCost = curr.costUsd ?? 0;
        const gapMinutes = Math.round(gapMs / 60_000);

        reports.push(
          createWasteReport({
            traceId: context.trace.id,
            spanId: curr.id,
            category: "cache_expiry",
            severity: severityFromCost(spanCost * 0.1),
            wastedTokens: cacheWriteTokens,
            wastedCostUsd: 0, // Not adding to headline waste — indicative only
            description: `${gapMinutes}min idle gap before turn #${i + 1} caused cache expiry. ${(cacheWriteTokens / 1000).toFixed(0)}K tokens had to be re-cached.`,
            recommendation:
              "Keep the cache warm with periodic pings during idle periods, or batch your work to avoid long gaps.",
            estimatedSavingsUsd: 0,
            evidence: {
              gapMs,
              gapMinutes,
              cacheWriteTokens,
              cacheReadTokens,
              totalContextTokens,
              prevSpanId: prev.id,
            },
          }),
        );
      }

      return reports;
    });
  },
};
