import type { WasteReportRecord } from "@langcost/db";

import { createWasteReport, severityFromCost } from "./shared";
import type { ResolvedRuleConfig, WasteRule } from "./types";

interface SpanHistoryEntry {
  spanId: string;
  inputTokens: number;
  historyTokens: number;
  historyCostUsd: number;
  historyShare: number;
}

interface AffectedHistoryEntry extends SpanHistoryEntry {
  allowedHistoryTokens: number;
}

function computeAllowedHistoryTokens(
  entry: SpanHistoryEntry,
  minHistoryTokens: number,
  minHistoryShare: number,
): number {
  return Math.max(minHistoryTokens, entry.inputTokens * minHistoryShare);
}

function hasStrongGrowth(
  entries: SpanHistoryEntry[],
  minConsecutiveSpans: number,
  growthMultiplier: number,
): { detected: boolean; spanIds: string[] } {
  if (entries.length < minConsecutiveSpans) {
    return { detected: false, spanIds: [] };
  }

  let bestWindow: SpanHistoryEntry[] = [];
  let currentWindow: SpanHistoryEntry[] = [];

  for (const entry of entries) {
    const previous = currentWindow[currentWindow.length - 1];
    if (!previous || entry.historyTokens > previous.historyTokens) {
      currentWindow.push(entry);
    } else {
      currentWindow = [entry];
    }

    if (currentWindow.length > bestWindow.length) {
      bestWindow = [...currentWindow];
    }
  }

  if (bestWindow.length < minConsecutiveSpans) {
    return { detected: false, spanIds: [] };
  }

  const first = bestWindow[0];
  const last = bestWindow[bestWindow.length - 1];
  if (!first || !last || first.historyTokens <= 0) {
    return { detected: false, spanIds: [] };
  }

  const ratio = last.historyTokens / first.historyTokens;
  if (ratio < growthMultiplier) {
    return { detected: false, spanIds: [] };
  }

  return { detected: true, spanIds: bestWindow.map((entry) => entry.spanId) };
}

export const unboundedHistoryRule: WasteRule = {
  id: "unbounded-history",
  tier: 1,
  title: "Unbounded history",
  description: "Conversation history grows and dominates prompt input across turns.",
  defaultEnabled: true,
  requires: ["spans"],
  defaultThresholds: {
    minHistoryTokens: 4_000,
    minHistoryShare: 0.4,
    minConsecutiveGrowingSpans: 3,
    growthMultiplier: 1.5,
  },
  detect(contexts, config?: ResolvedRuleConfig): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const minHistoryTokens = Math.max(0, config?.thresholds.minHistoryTokens ?? 4_000);
      const minHistoryShare = Math.max(0, config?.thresholds.minHistoryShare ?? 0.4);
      const minConsecutiveGrowingSpans = Math.max(
        2,
        Math.round(config?.thresholds.minConsecutiveGrowingSpans ?? 3),
      );
      const growthMultiplier = Math.max(1, config?.thresholds.growthMultiplier ?? 1.5);

      const entries: SpanHistoryEntry[] = context.llmSpans
        .map((span) => {
          const inputTokens = span.inputTokens ?? 0;
          if (inputTokens <= 0) {
            return undefined;
          }

          const historySegments = context.segments.filter(
            (segment) => segment.spanId === span.id && segment.type === "conversation_history",
          );
          if (historySegments.length === 0) {
            return undefined;
          }

          const historyTokens = historySegments.reduce(
            (sum, segment) => sum + segment.tokenCount,
            0,
          );
          if (historyTokens <= 0) {
            return undefined;
          }

          return {
            spanId: span.id,
            inputTokens,
            historyTokens,
            historyCostUsd: historySegments.reduce((sum, segment) => sum + segment.costUsd, 0),
            historyShare: historyTokens / inputTokens,
          };
        })
        .filter((entry): entry is SpanHistoryEntry => entry !== undefined);

      if (entries.length === 0) {
        return [];
      }

      const affected: AffectedHistoryEntry[] = entries
        .filter(
          (entry) =>
            entry.historyTokens >= minHistoryTokens && entry.historyShare >= minHistoryShare,
        )
        .map((entry) => ({
          ...entry,
          allowedHistoryTokens: computeAllowedHistoryTokens(
            entry,
            minHistoryTokens,
            minHistoryShare,
          ),
        }));
      if (affected.length === 0) {
        return [];
      }

      const growth = hasStrongGrowth(entries, minConsecutiveGrowingSpans, growthMultiplier);
      const wastedTokens = affected.reduce((sum, entry) => {
        return sum + Math.max(0, entry.historyTokens - entry.allowedHistoryTokens);
      }, 0);
      const wastedCostUsd = affected.reduce((sum, entry) => {
        const excessTokens = Math.max(0, entry.historyTokens - entry.allowedHistoryTokens);
        const excessCost =
          entry.historyTokens > 0 ? entry.historyCostUsd * (excessTokens / entry.historyTokens) : 0;
        return sum + excessCost;
      }, 0);
      const firstAffected = affected[0];
      if (!firstAffected) {
        return [];
      }

      return [
        createWasteReport({
          traceId: context.trace.id,
          spanId: firstAffected.spanId,
          category: "unbounded_history",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `${affected.length} LLM span(s) carried large conversation history chunks (${Math.round(minHistoryShare * 100)}%+ of input and ${minHistoryTokens.toLocaleString()}+ tokens).`,
          recommendation:
            "Summarize or prune prior turns, use a sliding context window, and keep only task-relevant history.",
          evidence: {
            affectedSpanIds: affected.map((entry) => entry.spanId),
            historySeries: entries.map((entry) => ({
              spanId: entry.spanId,
              historyTokens: entry.historyTokens,
              inputTokens: entry.inputTokens,
              historyShare: entry.historyShare,
            })),
            thresholds: {
              minHistoryTokens,
              minHistoryShare,
              minConsecutiveGrowingSpans,
              growthMultiplier,
            },
            growthDetected: growth.detected,
            growthSpanIds: growth.spanIds,
            estimatedExcessTokens: wastedTokens,
          },
        }),
      ];
    });
  },
};
