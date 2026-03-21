import type { WasteReportRecord } from "@langcost/db";

import { getSpanTotalTokens } from "../context";
import {
  createWasteReport,
  estimateModelSavings,
  findCheaperModel,
  severityFromCost,
} from "./shared";
import type { WasteRule } from "./types";

export const modelOveruseRule: WasteRule = {
  name: "model-overuse",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      if (context.llmSpans.length === 0) {
        return [];
      }

      const spansByModel = new Map<string, typeof context.llmSpans>();
      for (const span of context.llmSpans) {
        if (!span.model) {
          continue;
        }

        const spans = spansByModel.get(span.model) ?? [];
        spans.push(span);
        spansByModel.set(span.model, spans);
      }

      const dominantEntry = [...spansByModel.entries()].sort(
        (left, right) => right[1].length - left[1].length,
      )[0];

      if (!dominantEntry) {
        return [];
      }

      const [dominantModel, dominantSpans] = dominantEntry;
      const dominantShare = dominantSpans.length / context.llmSpans.length;
      const cheaperModel = findCheaperModel(dominantModel);
      const averageOutputTokens =
        dominantSpans.reduce((total, span) => total + (span.outputTokens ?? 0), 0) /
        dominantSpans.length;
      const isSimpleOrToolHeavy = context.toolSpans.length > 0 || averageOutputTokens < 200;

      if (!cheaperModel || dominantShare <= 0.7 || !isSimpleOrToolHeavy) {
        return [];
      }

      const potentialSavings = estimateModelSavings(dominantSpans, cheaperModel);
      if (potentialSavings <= 0) {
        return [];
      }

      return [
        createWasteReport({
          traceId: context.trace.id,
          category: "model_overuse",
          severity: severityFromCost(potentialSavings),
          wastedTokens: dominantSpans.reduce((total, span) => total + getSpanTotalTokens(span), 0),
          wastedCostUsd: potentialSavings,
          estimatedSavingsUsd: potentialSavings,
          description: `${Math.round(dominantShare * 100)}% of LLM spans in this trace used ${dominantModel} for simple or tool-heavy work.`,
          recommendation: `Consider ${cheaperModel} for these turns. Estimated savings for this trace: $${potentialSavings.toFixed(4)}.`,
          evidence: {
            dominantModel,
            dominantShare,
            cheaperModel,
            spanIds: dominantSpans.map((span) => span.id),
          },
        }),
      ];
    });
  },
};
