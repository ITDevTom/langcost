import type { ModelPricing } from "./providers";
import { MODEL_PRICING } from "./providers";

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function validateTokenCount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative number.`);
  }
}

export function findPricing(model: string): ModelPricing | undefined {
  const normalizedModel = normalizeModelName(model);

  return MODEL_PRICING.find((entry) => {
    if (normalizeModelName(entry.model) === normalizedModel) {
      return true;
    }

    return entry.aliases.some((alias) => normalizeModelName(alias) === normalizedModel);
  });
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number) {
  validateTokenCount(inputTokens, "inputTokens");
  validateTokenCount(outputTokens, "outputTokens");

  const pricing = findPricing(model);
  if (!pricing) {
    return {
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMToken;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMToken;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

export function calculateCostWithCache(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cacheDuration: "5m" | "1h" = "1h",
) {
  validateTokenCount(inputTokens, "inputTokens");
  validateTokenCount(outputTokens, "outputTokens");
  validateTokenCount(cacheCreationTokens, "cacheCreationTokens");
  validateTokenCount(cacheReadTokens, "cacheReadTokens");

  const pricing = findPricing(model);
  if (!pricing) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
    };
  }

  const cacheWritePrice = cacheDuration === "1h"
    ? pricing.cacheWrite1hInputPricePerMToken
    : pricing.cacheWrite5mInputPricePerMToken;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMToken;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMToken;
  const cacheWriteCost = cacheWritePrice
    ? (cacheCreationTokens / 1_000_000) * cacheWritePrice
    : 0;
  const cacheReadCost = pricing.cachedInputPricePerMToken
    ? (cacheReadTokens / 1_000_000) * pricing.cachedInputPricePerMToken
    : 0;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}
