import type { WasteReportRecord } from "@langcost/db";

import { getNumericMetadataValue } from "../context";
import { createWasteReport, severityFromCost } from "./shared";
import type { ResolvedRuleConfig, WasteRule } from "./types";

const STABLE_SEGMENT_TYPES = new Set(["system_prompt", "tool_schema"]);

function getCacheReadTokens(
  metadata: Record<string, unknown> | null | undefined,
): number | undefined {
  return (
    getNumericMetadataValue(metadata, "cacheRead") ??
    getNumericMetadataValue(metadata, "cacheReadTokens") ??
    getNumericMetadataValue(metadata, "cacheReads")
  );
}

export const uncachedPromptRule: WasteRule = {
  id: "uncached-prompt",
  tier: 1,
  title: "Uncached prompt",
  description: "Repeated stable prompt segments were sent with little or no cache-read benefit.",
  defaultEnabled: true,
  defaultThresholds: {
    minRepeatedTokens: 8_000,
    minOccurrences: 2,
    maxCacheReadRatio: 0.1,
  },
  detect(contexts, config?: ResolvedRuleConfig): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const minRepeatedTokens = Math.max(0, config?.thresholds.minRepeatedTokens ?? 8_000);
      const minOccurrences = Math.max(2, Math.round(config?.thresholds.minOccurrences ?? 2));
      const maxCacheReadRatio = Math.max(0, config?.thresholds.maxCacheReadRatio ?? 0.1);

      const llmSpanById = new Map(context.llmSpans.map((span) => [span.id, span]));
      const stableSegments = context.segments.filter(
        (segment) =>
          STABLE_SEGMENT_TYPES.has(segment.type) &&
          typeof segment.contentHash === "string" &&
          llmSpanById.has(segment.spanId),
      );
      if (stableSegments.length < minOccurrences) {
        return [];
      }

      const groupedByHash = new Map<string, typeof stableSegments>();
      for (const segment of stableSegments) {
        const hash = segment.contentHash;
        if (!hash) {
          continue;
        }
        const existing = groupedByHash.get(hash) ?? [];
        existing.push(segment);
        groupedByHash.set(hash, existing);
      }

      const duplicatedHashes: string[] = [];
      const repeatedSegments: typeof stableSegments = [];
      for (const [hash, segments] of groupedByHash) {
        if (segments.length < minOccurrences) {
          continue;
        }
        duplicatedHashes.push(hash);
        repeatedSegments.push(...segments.slice(1));
      }
      if (repeatedSegments.length === 0) {
        return [];
      }

      const repeatedTokens = repeatedSegments.reduce((sum, segment) => sum + segment.tokenCount, 0);
      if (repeatedTokens < minRepeatedTokens) {
        return [];
      }

      const affectedSpanIds = [...new Set(repeatedSegments.map((segment) => segment.spanId))];
      const affectedSpans = affectedSpanIds
        .map((spanId) => llmSpanById.get(spanId))
        .filter((span): span is NonNullable<typeof span> => span !== undefined);
      if (affectedSpans.length === 0) {
        return [];
      }

      const cacheReads = affectedSpans
        .map((span) => getCacheReadTokens(span.metadata))
        .filter((value): value is number => value !== undefined);
      if (cacheReads.length === 0) {
        return [];
      }

      const totalCacheReadTokens = cacheReads.reduce((sum, value) => sum + value, 0);
      const totalInputTokens = affectedSpans.reduce(
        (sum, span) => sum + (span.inputTokens ?? 0),
        0,
      );
      const cacheReadRatio = totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0;
      if (cacheReadRatio > maxCacheReadRatio) {
        return [];
      }

      const wastedCostUsd = repeatedSegments.reduce((sum, segment) => sum + segment.costUsd, 0);
      const firstRepeated = repeatedSegments[0];
      if (!firstRepeated) {
        return [];
      }

      return [
        createWasteReport({
          traceId: context.trace.id,
          spanId: firstRepeated.spanId,
          category: "uncached_prompt",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens: repeatedTokens,
          wastedCostUsd,
          description: `Repeated stable prompt content appeared in ${repeatedSegments.length} segment(s) with low cache reads (${(cacheReadRatio * 100).toFixed(1)}%).`,
          recommendation:
            "Enable prompt caching for stable system/tool-schema sections and keep those sections structurally identical across turns.",
          evidence: {
            duplicatedContentHashes: duplicatedHashes,
            affectedSpanIds,
            repeatedSegmentIds: repeatedSegments.map((segment) => segment.id),
            repeatedStablePromptTokens: repeatedTokens,
            observedCacheReadTokens: totalCacheReadTokens,
            totalInputTokens,
            cacheReadRatio,
            stableSegmentTypes: [...new Set(repeatedSegments.map((segment) => segment.type))],
            thresholds: {
              minRepeatedTokens,
              minOccurrences,
              maxCacheReadRatio,
            },
          },
        }),
      ];
    });
  },
};
