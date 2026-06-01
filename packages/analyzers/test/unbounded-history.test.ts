import { describe, expect, it } from "bun:test";
import type { SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { unboundedHistoryRule } from "../src/rules/unbounded-history";

const TRACE_ID = "trace-unbounded-history";

function makeTrace(): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-history",
    source: "test",
    sessionKey: "session-history",
    startedAt: now,
    endedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    model: "claude-sonnet-4-6",
    status: "complete",
    metadata: {},
    ingestedAt: now,
  };
}

function makeLlmSpan(id: string, minute: number, inputTokens: number): SpanRecord {
  const startedAt = new Date(`2026-05-06T10:${String(minute).padStart(2, "0")}:00Z`);
  return {
    id,
    traceId: TRACE_ID,
    parentSpanId: null,
    externalId: id,
    type: "llm",
    name: "assistant",
    startedAt,
    endedAt: startedAt,
    durationMs: null,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens,
    outputTokens: 200,
    costUsd: 0.1,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata: null,
  };
}

function makeHistorySegment(
  id: string,
  spanId: string,
  tokenCount: number,
  costUsd: number,
): SegmentRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    type: "conversation_history",
    tokenCount,
    costUsd,
    percentOfSpan: 10,
    contentHash: `hash:${id}`,
    charStart: null,
    charEnd: null,
    analyzedAt: new Date("2026-05-06T10:00:00Z"),
  };
}

describe("unboundedHistoryRule", () => {
  it("flags large dominant conversation history and reports growth evidence", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 8_000),
      makeLlmSpan("llm-2", 2, 10_000),
      makeLlmSpan("llm-3", 3, 12_000),
    ];
    const segments = [
      makeHistorySegment("seg-1", "llm-1", 4_500, 0.08),
      makeHistorySegment("seg-2", "llm-2", 5_000, 0.1),
      makeHistorySegment("seg-3", "llm-3", 6_000, 0.12),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = unboundedHistoryRule.detect([context]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("unbounded_history");
    expect(reports[0]?.spanId).toBe("llm-1");
    expect(reports[0]?.wastedTokens).toBe(2_700);
    expect(reports[0]?.wastedCostUsd).toBeCloseTo(0.0528888888, 8);

    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.affectedSpanIds).toEqual(["llm-1", "llm-2", "llm-3"]);
    expect(evidence.growthDetected).toBe(false);
    expect(evidence.thresholds).toEqual({
      minHistoryTokens: 4_000,
      minHistoryShare: 0.4,
      minConsecutiveGrowingSpans: 3,
      growthMultiplier: 1.5,
    });
  });

  it("does not flag high history tokens when share of input is small", () => {
    const spans = [makeLlmSpan("llm-1", 1, 20_000), makeLlmSpan("llm-2", 2, 25_000)];
    const segments = [
      makeHistorySegment("seg-1", "llm-1", 5_000, 0.08),
      makeHistorySegment("seg-2", "llm-2", 6_000, 0.1),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = unboundedHistoryRule.detect([context]);
    expect(reports).toHaveLength(0);
  });

  it("reports growthDetected when history clearly clears the multiplier", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 8_000),
      makeLlmSpan("llm-2", 2, 16_000),
      makeLlmSpan("llm-3", 3, 32_000),
    ];
    const segments = [
      makeHistorySegment("seg-1", "llm-1", 4_000, 0.06),
      makeHistorySegment("seg-2", "llm-2", 8_000, 0.12),
      makeHistorySegment("seg-3", "llm-3", 16_000, 0.24),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = unboundedHistoryRule.detect([context]);

    expect(reports).toHaveLength(1);
    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.growthDetected).toBe(true);
    expect(evidence.growthSpanIds).toEqual(["llm-1", "llm-2", "llm-3"]);
  });

  it("detects growth after a mid-series dip (window reset)", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 10_000),
      makeLlmSpan("llm-2", 2, 12_000),
      makeLlmSpan("llm-3", 3, 8_000),
      makeLlmSpan("llm-4", 4, 10_000),
      makeLlmSpan("llm-5", 5, 16_000),
      makeLlmSpan("llm-6", 6, 24_000),
    ];
    const segments = [
      makeHistorySegment("seg-1", "llm-1", 5_000, 0.08),
      makeHistorySegment("seg-2", "llm-2", 6_000, 0.10),
      makeHistorySegment("seg-3", "llm-3", 3_000, 0.05),
      makeHistorySegment("seg-4", "llm-4", 4_500, 0.07),
      makeHistorySegment("seg-5", "llm-5", 8_000, 0.12),
      makeHistorySegment("seg-6", "llm-6", 12_000, 0.20),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = unboundedHistoryRule.detect([context]);

    expect(reports).toHaveLength(1);
    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.growthDetected).toBe(true);
    expect(evidence.growthSpanIds).toEqual(["llm-3", "llm-4", "llm-5", "llm-6"]);
  });

  it("supports threshold overrides via resolved config", () => {
    const spans = [makeLlmSpan("llm-1", 1, 7_000)];
    const segments = [makeHistorySegment("seg-1", "llm-1", 2_500, 0.05)];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = unboundedHistoryRule.detect([context], {
      thresholds: {
        minHistoryTokens: 2_000,
        minHistoryShare: 0.3,
      },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("unbounded_history");
    expect(reports[0]?.wastedTokens).toBe(400);
  });
});
