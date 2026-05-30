import { describe, expect, it } from "bun:test";
import type { SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { uncachedPromptRule } from "../src/rules/uncached-prompt";

const TRACE_ID = "trace-uncached-prompt";

function makeTrace(): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-uncached",
    source: "test",
    sessionKey: "session-uncached",
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

function makeLlmSpan(
  id: string,
  minute: number,
  inputTokens: number,
  metadata: Record<string, unknown> | null,
): SpanRecord {
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
    outputTokens: 500,
    costUsd: 0.2,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata,
  };
}

function makeSegment(
  id: string,
  spanId: string,
  type: SegmentRecord["type"],
  tokenCount: number,
  contentHash: string,
): SegmentRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    type,
    tokenCount,
    costUsd: 0.01,
    percentOfSpan: 10,
    contentHash,
    charStart: null,
    charEnd: null,
    analyzedAt: new Date("2026-05-06T10:00:00Z"),
  };
}

describe("uncachedPromptRule", () => {
  it("flags repeated stable prompt hashes when cache read ratio is low", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 20_000, { cacheRead: 500 }),
      makeLlmSpan("llm-2", 2, 20_000, { cacheReadTokens: 300 }),
      makeLlmSpan("llm-3", 3, 15_000, { cacheReads: 200 }),
    ];
    const segments = [
      makeSegment("seg-1", "llm-1", "system_prompt", 4_000, "hash-system"),
      makeSegment("seg-2", "llm-2", "system_prompt", 4_000, "hash-system"),
      makeSegment("seg-3", "llm-3", "tool_schema", 5_000, "hash-tools"),
      makeSegment("seg-4", "llm-1", "tool_schema", 5_000, "hash-tools"),
      makeSegment("seg-5", "llm-2", "conversation_history", 7_000, "hash-history"),
    ];

    const context = buildTraceContext(makeTrace(), spans, [], segments);
    const reports = uncachedPromptRule.detect([context]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("uncached_prompt");
    expect(reports[0]?.wastedTokens).toBe(9_000);
    expect(reports[0]?.wastedCostUsd).toBeCloseTo(0.02, 8);

    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.duplicatedContentHashes).toEqual(["hash-system", "hash-tools"]);
    expect(evidence.observedCacheReadTokens).toBe(800);
  });

  it("does not flag when cache read ratio is healthy", () => {
    const spans = [
      makeLlmSpan("llm-1", 1, 10_000, { cacheRead: 5_000 }),
      makeLlmSpan("llm-2", 2, 10_000, { cacheRead: 5_000 }),
    ];
    const segments = [
      makeSegment("seg-1", "llm-1", "system_prompt", 5_000, "hash-a"),
      makeSegment("seg-2", "llm-2", "system_prompt", 5_000, "hash-a"),
    ];

    const context = buildTraceContext(makeTrace(), spans, [], segments);
    const reports = uncachedPromptRule.detect([context]);
    expect(reports).toHaveLength(0);
  });
});
