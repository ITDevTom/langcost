import { describe, expect, it } from "bun:test";

import { calculateCost, calculateCostWithCache, findPricing } from "./calculator";

describe("findPricing", () => {
  it("matches canonical model names", () => {
    expect(findPricing("gpt-4o")?.provider).toBe("openai");
  });

  it("matches aliases case-insensitively", () => {
    expect(findPricing("SONNET-4")?.model).toBe("claude-sonnet-4-20250514");
  });

  it("distinguishes Opus 4.6 from Opus 4.0 pricing", () => {
    const opus46 = findPricing("claude-opus-4-6");
    const opus4 = findPricing("claude-opus-4");

    expect(opus46?.inputPricePerMToken).toBe(5);
    expect(opus4?.inputPricePerMToken).toBe(15);
  });
});

describe("calculateCost", () => {
  it("calculates input and output cost", () => {
    expect(calculateCost("gpt-4o", 1_000_000, 500_000)).toEqual({
      inputCost: 2.5,
      outputCost: 5,
      totalCost: 7.5,
    });
  });

  it("returns zero cost for unknown models", () => {
    expect(calculateCost("unknown-model", 100, 200)).toEqual({
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    });
  });
});

describe("calculateCostWithCache", () => {
  it("calculates cost with 1h cache (default) for Opus 4.6", () => {
    // Opus 4.6: $5/M input, $25/M output, $10/M 1h cache write, $0.50/M cache read
    const result = calculateCostWithCache(
      "claude-opus-4-6",
      1_000_000, // input
      1_000_000, // output
      1_000_000, // cache write
      1_000_000, // cache read
    );

    expect(result.inputCost).toBeCloseTo(5, 2);
    expect(result.outputCost).toBeCloseTo(25, 2);
    expect(result.cacheWriteCost).toBeCloseTo(10, 2);
    expect(result.cacheReadCost).toBeCloseTo(0.5, 2);
    expect(result.totalCost).toBeCloseTo(40.5, 2);
  });

  it("calculates cost with 5m cache for Opus 4.6", () => {
    // Opus 4.6: $6.25/M 5m cache write
    const result = calculateCostWithCache(
      "claude-opus-4-6",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      "5m",
    );

    expect(result.cacheWriteCost).toBeCloseTo(6.25, 2);
    expect(result.totalCost).toBeCloseTo(36.75, 2);
  });

  it("calculates cost with cache tokens for Sonnet", () => {
    // Sonnet: $3/M input, $15/M output, $6/M 1h cache write, $0.3/M cache read
    const result = calculateCostWithCache(
      "claude-sonnet-4-6",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
    );

    expect(result.inputCost).toBeCloseTo(3, 2);
    expect(result.outputCost).toBeCloseTo(15, 2);
    expect(result.cacheWriteCost).toBeCloseTo(6, 2);
    expect(result.cacheReadCost).toBeCloseTo(0.3, 2);
    expect(result.totalCost).toBeCloseTo(24.3, 2);
  });

  it("handles zero cache tokens", () => {
    const result = calculateCostWithCache("claude-sonnet-4-6", 1000, 500, 0, 0);

    expect(result.cacheWriteCost).toBe(0);
    expect(result.cacheReadCost).toBe(0);
    expect(result.totalCost).toBe(result.inputCost + result.outputCost);
  });

  it("returns all zeros for unknown models", () => {
    const result = calculateCostWithCache("unknown-model", 1000, 500, 200, 300);

    expect(result).toEqual({
      inputCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
    });
  });

  it("works with models that have no cache pricing", () => {
    // Mistral large has no cache pricing
    const result = calculateCostWithCache("mistral-large-latest", 1_000_000, 1_000_000, 500_000, 500_000);

    expect(result.inputCost).toBeCloseTo(2, 2);
    expect(result.outputCost).toBeCloseTo(6, 2);
    expect(result.cacheWriteCost).toBe(0);
    expect(result.cacheReadCost).toBe(0);
  });

  it("validates token counts are non-negative", () => {
    expect(() => calculateCostWithCache("claude-opus-4-6", -1, 0, 0, 0)).toThrow(RangeError);
    expect(() => calculateCostWithCache("claude-opus-4-6", 0, -1, 0, 0)).toThrow(RangeError);
    expect(() => calculateCostWithCache("claude-opus-4-6", 0, 0, -1, 0)).toThrow(RangeError);
    expect(() => calculateCostWithCache("claude-opus-4-6", 0, 0, 0, -1)).toThrow(RangeError);
  });
});
