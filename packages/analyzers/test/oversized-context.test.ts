import { describe, expect, it } from "bun:test";
import type { SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { oversizedContextRule } from "../src/rules/oversized-context";

const TRACE_ID = "trace-oversized-context";

function makeTrace(): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-oversized",
    source: "test",
    sessionKey: "session-oversized",
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

function makeLlmSpan(id: string, minute: number, inputTokens: number, costUsd: number): SpanRecord {
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
    costUsd,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata: null,
  };
}

function makeSegment(
  id: string,
  spanId: string,
  type: SegmentRecord["type"],
  tokenCount: number,
): SegmentRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    type,
    tokenCount,
    costUsd: 0.001,
    percentOfSpan: 10,
    contentHash: `hash:${id}`,
    charStart: null,
    charEnd: null,
    analyzedAt: new Date("2026-05-06T10:00:00Z"),
  };
}

describe("oversizedContextRule", () => {
  it("flags large absolute input context with segment evidence", () => {
    const spans = [makeLlmSpan("llm-1", 1, 1200, 0.02), makeLlmSpan("llm-2", 2, 60_000, 0.8)];
    const segments = [
      makeSegment("seg-1", "llm-2", "conversation_history", 30_000),
      makeSegment("seg-2", "llm-2", "rag_context", 20_000),
      makeSegment("seg-3", "llm-2", "system_prompt", 10_000),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], segments);

    const reports = oversizedContextRule.detect([context]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("oversized_context");
    expect(reports[0]?.spanId).toBe("llm-2");
    expect((reports[0]?.evidence as Record<string, unknown>).traceMedianInputTokens).toBe(30_600);
    expect((reports[0]?.evidence as Record<string, unknown>).triggeredBy).toEqual({
      absolute: true,
      relativeToMedian: false,
    });
  });

  it("flags median-relative oversized context when absolute threshold is overridden high", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 1_000, 0.03),
      makeLlmSpan("llm-2", 2, 1_200, 0.03),
      makeLlmSpan("llm-3", 3, 4_500, 0.09),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], []);

    const reports = oversizedContextRule.detect([context], {
      thresholds: {
        minInputTokens: 100_000,
        medianMultiplier: 3,
      },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.spanId).toBe("llm-3");
    expect((reports[0]?.evidence as Record<string, unknown>).triggeredBy).toEqual({
      absolute: false,
      relativeToMedian: true,
    });
  });

  it("does not flag when all spans stay below both thresholds", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 900, 0.02),
      makeLlmSpan("llm-2", 2, 1_100, 0.03),
      makeLlmSpan("llm-3", 3, 1_500, 0.04),
    ];
    const context = buildTraceContext(makeTrace(), spans, [], []);

    const reports = oversizedContextRule.detect([context]);
    expect(reports).toHaveLength(0);
  });
});
