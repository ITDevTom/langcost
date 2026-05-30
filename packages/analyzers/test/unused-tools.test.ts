import { describe, expect, it } from "bun:test";
import type { MessageRecord, SegmentRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { unusedToolsRule } from "../src/rules/unused-tools";

const TRACE_ID = "trace-unused-tools";

function makeTrace(): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-unused-tools",
    source: "test",
    sessionKey: "session-unused-tools",
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
    inputTokens: 1_000,
    outputTokens: 300,
    costUsd: 0.05,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata: null,
  };
}

function makeToolSpan(
  id: string,
  minute: number,
  toolName: string,
  toolOutput: string,
  toolInput = "",
): SpanRecord {
  const startedAt = new Date(`2026-05-06T10:${String(minute).padStart(2, "0")}:00Z`);
  return {
    id,
    traceId: TRACE_ID,
    parentSpanId: null,
    externalId: id,
    type: "tool",
    name: toolName,
    startedAt,
    endedAt: startedAt,
    durationMs: null,
    model: null,
    provider: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    toolName,
    toolInput,
    toolOutput,
    toolSuccess: true,
    status: "ok",
    errorMessage: null,
    metadata: null,
  };
}

function makeToolResultSegment(
  id: string,
  spanId: string,
  tokenCount: number,
  costUsd: number,
): SegmentRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    type: "tool_result",
    tokenCount,
    costUsd,
    percentOfSpan: 100,
    contentHash: `hash:${id}`,
    charStart: null,
    charEnd: null,
    analyzedAt: new Date("2026-05-06T10:00:00Z"),
  };
}

function makeMessage(
  id: string,
  spanId: string,
  role: MessageRecord["role"],
  content: string,
): MessageRecord {
  return {
    id,
    spanId,
    traceId: TRACE_ID,
    role,
    content,
    tokenCount: null,
    position: 0,
    metadata: null,
  };
}

describe("unusedToolsRule", () => {
  it("flags large tool output with very low overlap to subsequent usage", () => {
    const toolOutput = "server metrics heap allocations stack traces megabytes process snapshots";
    const spans = [
      makeToolSpan("tool-1", 1, "Bash", toolOutput),
      makeLlmSpan("llm-1", 2),
      makeToolSpan("tool-2", 3, "Read", "small file", "cat README.md"),
    ];
    const segments = [
      makeToolResultSegment("seg-1", "tool-1", 3_000, 0.03),
      makeToolResultSegment("seg-2", "tool-2", 100, 0.001),
    ];
    const messages = [
      makeMessage("msg-1", "llm-1", "assistant", "Let's rename a function and rerun tests."),
    ];

    const context = buildTraceContext(makeTrace(), spans, messages, segments);
    const reports = unusedToolsRule.detect([context]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.category).toBe("unused_tools");
    expect(reports[0]?.wastedTokens).toBe(3_000);
    expect(reports[0]?.wastedCostUsd).toBeCloseTo(0.03, 8);

    const evidence = reports[0]?.evidence as Record<string, unknown>;
    expect(evidence.toolSpanIds).toEqual(["tool-1"]);
  });

  it("does not flag productive tool names even with large outputs", () => {
    const spans = [
      makeToolSpan("tool-1", 1, "Edit", "a lot of changed code output"),
      makeLlmSpan("llm-1", 2),
    ];
    const segments = [makeToolResultSegment("seg-1", "tool-1", 4_000, 0.04)];
    const messages = [
      makeMessage("msg-1", "llm-1", "assistant", "Applied patch and updated tests."),
    ];

    const context = buildTraceContext(makeTrace(), spans, messages, segments);
    const reports = unusedToolsRule.detect([context]);
    expect(reports).toHaveLength(0);
  });

  it("does not flag productive tools when adapter emits alias-style names", () => {
    const spans = [
      makeToolSpan("tool-1", 1, "write_to_file", "a lot of changed code output"),
      makeLlmSpan("llm-1", 2),
    ];
    const segments = [makeToolResultSegment("seg-1", "tool-1", 4_000, 0.04)];
    const messages = [
      makeMessage("msg-1", "llm-1", "assistant", "Applied patch and updated tests."),
    ];

    const context = buildTraceContext(makeTrace(), spans, messages, segments);
    const reports = unusedToolsRule.detect([context]);
    expect(reports).toHaveLength(0);
  });
});
