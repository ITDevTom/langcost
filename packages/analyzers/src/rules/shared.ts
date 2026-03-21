import {
  calculateCost,
  findPricing,
  MODEL_PRICING,
  type Severity,
  type WasteCategory,
} from "@langcost/core";
import type { SpanRecord, WasteReportRecord } from "@langcost/db";

import { getSpanCost, getSpanTotalTokens } from "../context";

export interface WasteReportDraft {
  traceId: string;
  spanId?: string;
  category: WasteCategory;
  severity: Severity;
  wastedTokens: number;
  wastedCostUsd: number;
  description: string;
  recommendation: string;
  estimatedSavingsUsd?: number;
  evidence: Record<string, unknown>;
}

export function createWasteReport(draft: WasteReportDraft): WasteReportRecord {
  return {
    id: crypto.randomUUID(),
    traceId: draft.traceId,
    spanId: draft.spanId ?? null,
    category: draft.category,
    severity: draft.severity,
    wastedTokens: Math.max(0, Math.round(draft.wastedTokens)),
    wastedCostUsd: Math.max(0, draft.wastedCostUsd),
    description: draft.description,
    recommendation: draft.recommendation,
    estimatedSavingsUsd: draft.estimatedSavingsUsd ?? null,
    evidence: draft.evidence,
    detectedAt: new Date(),
  };
}

export function severityFromCost(costUsd: number): Severity {
  if (costUsd >= 0.25) {
    return "critical";
  }

  if (costUsd >= 0.05) {
    return "high";
  }

  if (costUsd >= 0.01) {
    return "medium";
  }

  return "low";
}

export function toWordSet(content: string): Set<string> {
  const matches = content.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(matches);
}

export function jaccardSimilarity(left: string, right: string): number {
  const leftWords = toWordSet(left);
  const rightWords = toWordSet(right);

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftWords, ...rightWords]).size;
  return union === 0 ? 0 : intersection / union;
}

function getModelPriceScore(model: string): number | undefined {
  const pricing = findPricing(model);
  return pricing ? pricing.inputPricePerMToken + pricing.outputPricePerMToken : undefined;
}

export function findCheaperModel(model: string): string | undefined {
  const current = findPricing(model);
  const currentScore = getModelPriceScore(model);
  if (!current || currentScore === undefined) {
    return undefined;
  }

  const sameProvider = MODEL_PRICING.filter(
    (pricing) => pricing.provider === current.provider && pricing.model !== current.model,
  )
    .filter(
      (pricing) => (getModelPriceScore(pricing.model) ?? Number.POSITIVE_INFINITY) < currentScore,
    )
    .sort(
      (left, right) =>
        (getModelPriceScore(left.model) ?? 0) - (getModelPriceScore(right.model) ?? 0),
    );

  if (sameProvider.length > 0) {
    return sameProvider[0]?.model;
  }

  return MODEL_PRICING.filter(
    (pricing) => (getModelPriceScore(pricing.model) ?? Number.POSITIVE_INFINITY) < currentScore,
  ).sort(
    (left, right) => (getModelPriceScore(left.model) ?? 0) - (getModelPriceScore(right.model) ?? 0),
  )[0]?.model;
}

export function estimateModelSavings(spans: SpanRecord[], replacementModel: string): number {
  return spans.reduce((total, span) => {
    const existingCost = getSpanCost(span);
    const projectedCost = calculateCost(
      replacementModel,
      span.inputTokens ?? 0,
      span.outputTokens ?? 0,
    ).totalCost;
    return total + Math.max(0, existingCost - projectedCost);
  }, 0);
}

export function getOutputCostUsd(span: SpanRecord): number {
  const totalTokens = getSpanTotalTokens(span);
  if (totalTokens === 0) {
    return 0;
  }

  return getSpanCost(span) * ((span.outputTokens ?? 0) / totalTokens);
}
