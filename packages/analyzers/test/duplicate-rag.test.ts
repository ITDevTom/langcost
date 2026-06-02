import { describe, expect, it } from "bun:test";
import type { SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { duplicateRagRule } from "../src/rules/duplicate-rag";

const TRACE_ID = "trace-duplicate-rag";

function makeTrace(): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-rag",
    source: "test",
    sessionKey: "session-rag",
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

function makeLlmSpan(id: string, minute: number): SpanRecord {
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
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0.02,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata: null,
  };
}

function makeRagSegment(
  id: string,
  spanId: string,
  tokenCount: number,
  costUsd: number,
  contentHash: string | null,
): SegmentRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    type: "rag_context",
    tokenCount,
    costUsd,
    percentOfSpan: 10,
    contentHash,
    charStart: null,
    charEnd: null,
    analyzedAt: new Date("2026-05-06T10:00:00Z"),
  };
}

describe("duplicateRagRule", () => {
  it("flags repeated rag_context segments by content hash and counts repeats after first", () => {
    const spans = [makeLlmSpan("llm-1", 1), makeLlmSpan("llm-2", 2), makeLlmSpan("llm-3", 3)];
    const segments = [
      makeRagSegment("seg-1", "llm-1", 100, 0.002, "hash-a"),
      makeRagSegment("seg-2", "llm-2", 150, 0.003, "hash-a"),
      makeRagSegment("seg-3", "llm-3", 200, 0.004, "hash-a"),
      makeRagSegment("seg-4", "llm-3", 120, 0.0024, "hash-b"),
    ];

    const context = buildTraceContext(makeTrace(), spans, [], segments);
    const reports = duplicateRagRule.detect([context]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("duplicate_rag");
    expect(reports[0]?.wastedTokens).toBe(350);
    expect(reports[0]?.wastedCostUsd).toBeCloseTo(0.007, 8);
    expect(reports[0]?.spanId).toBe("llm-2");

    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.duplicatedContentHashes).toEqual(["hash-a"]);
    expect(evidence.repeatedSegmentIds).toEqual(["seg-2", "seg-3"]);
    expect(evidence.repeatedSpanIds).toEqual(["llm-2", "llm-3"]);
  });

  it("does not flag single-occurrence or hashless rag_context segments", () => {
    const spans = [makeLlmSpan("llm-1", 1), makeLlmSpan("llm-2", 2)];
    const segments = [
      makeRagSegment("seg-1", "llm-1", 100, 0.002, "hash-a"),
      makeRagSegment("seg-2", "llm-2", 120, 0.0024, "hash-b"),
      makeRagSegment("seg-3", "llm-2", 80, 0.0016, null),
    ];

    const context = buildTraceContext(makeTrace(), spans, [], segments);
    const reports = duplicateRagRule.detect([context]);

    expect(reports).toHaveLength(0);
  });
});
