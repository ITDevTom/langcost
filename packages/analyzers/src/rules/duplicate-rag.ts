import type { WasteReportRecord } from "@langcost/db";

import { createWasteReport, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

export const duplicateRagRule: WasteRule = {
  id: "duplicate-rag",
  tier: 2,
  title: "Duplicate RAG context",
  description: "Repeated RAG context segments with identical content hashes.",
  defaultEnabled: false,
  requires: ["spans"],
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const ragSegments = context.segments.filter(
        (segment) => segment.type === "rag_context" && typeof segment.contentHash === "string",
      );

      if (ragSegments.length < 2) {
        return [];
      }

      const segmentsByHash = new Map<string, typeof ragSegments>();
      for (const segment of ragSegments) {
        const hash = segment.contentHash;
        if (!hash) {
          continue;
        }

        const existing = segmentsByHash.get(hash) ?? [];
        existing.push(segment);
        segmentsByHash.set(hash, existing);
      }

      const duplicateHashes: string[] = [];
      const repeatedSegments: typeof ragSegments = [];
      for (const [hash, segments] of segmentsByHash) {
        if (segments.length < 2) {
          continue;
        }

        duplicateHashes.push(hash);
        repeatedSegments.push(...segments.slice(1));
      }

      if (repeatedSegments.length === 0) {
        return [];
      }

      const wastedTokens = repeatedSegments.reduce((sum, segment) => sum + segment.tokenCount, 0);
      const wastedCostUsd = repeatedSegments.reduce((sum, segment) => sum + segment.costUsd, 0);
      const firstRepeated = repeatedSegments[0];

      return [
        createWasteReport({
          traceId: context.trace.id,
          ...(firstRepeated ? { spanId: firstRepeated.spanId } : {}),
          category: "duplicate_rag",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `Detected repeated RAG payloads across ${duplicateHashes.length} content hash(es), causing ${repeatedSegments.length} duplicate segment(s).`,
          recommendation:
            "Cache retrieved context and send only new or delta RAG content after the first occurrence.",
          evidence: {
            duplicatedContentHashes: duplicateHashes,
            repeatedSegmentIds: repeatedSegments.map((segment) => segment.id),
            repeatedSpanIds: [...new Set(repeatedSegments.map((segment) => segment.spanId))],
            repeatedTokenCount: wastedTokens,
            repeatedCostUsd: wastedCostUsd,
          },
        }),
      ];
    });
  },
};
