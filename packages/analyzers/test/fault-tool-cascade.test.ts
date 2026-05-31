import { describe, expect, it } from "bun:test";
import type { SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { toolCascadeRule } from "../src/rules/fault/tool-cascade";

const TRACE_ID = "trace-fault";

function makeTrace(status: TraceRecord["status"] = "error"): TraceRecord {
  const now = new Date("2026-05-06T10:00:00Z");
  return {
    id: TRACE_ID,
    externalId: "ext-1",
    source: "sample",
    sessionKey: "s1",
    startedAt: now,
    endedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    model: "gpt-4o",
    status,
    metadata: {},
    ingestedAt: now,
  };
}

type SpanInit = Partial<SpanRecord> & { id: string; startMin: number; type: SpanRecord["type"] };

function span(init: SpanInit): SpanRecord {
  const { startMin, ...rest } = init;
  const startedAt = new Date(`2026-05-06T10:${String(startMin).padStart(2, "0")}:00Z`);
  return {
    traceId: TRACE_ID,
    parentSpanId: null,
    externalId: init.id,
    name: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    model: null,
    provider: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolSuccess: null,
    status: "ok",
    errorMessage: null,
    metadata: null,
    ...rest,
    id: init.id,
  } as SpanRecord;
}

function run(spans: SpanRecord[], status: TraceRecord["status"] = "error") {
  return toolCascadeRule.detect([buildTraceContext(makeTrace(status), spans, [], [])]);
}

describe("toolCascadeRule — first-failing-origin attribution", () => {
  it("collapses a retry storm into ONE report rooted at the first failing tool", () => {
    const spans: SpanRecord[] = [span({ id: "root", startMin: 0, type: "agent" })];
    for (let i = 0; i < 8; i++) {
      spans.push(
        span({
          id: `tool-${i}`,
          startMin: i + 1,
          type: "tool",
          parentSpanId: "root",
          toolName: "metrics_api",
          toolInput: JSON.stringify({ metric: "p99", attempt: i + 1 }),
          toolSuccess: false,
          status: "error",
          errorMessage: "503 Service Unavailable",
        }),
      );
    }
    spans.push(
      span({
        id: "give-up",
        startMin: 12,
        type: "llm",
        parentSpanId: "root",
        status: "error",
        errorMessage: "aborted after 8 retries",
      }),
    );

    const reports = run(spans);
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r?.rootCauseSpanId).toBe("tool-0"); // earliest failing tool
    expect(r?.faultSpanId).toBe("give-up"); // last visible symptom
    expect(r?.faultType).toBe("tool_failure");
    expect(r?.severity).toBe("critical"); // trace.status === error
    expect(r?.confidence).toBe("high");
    expect(r?.cascadeDepth).toBe(9); // 8 tools + give-up
    expect(r?.affectedSpanIds).toContain("tool-0");
    expect(r?.affectedSpanIds).toContain("give-up");
  });

  it("stays quiet when every failure later recovered on retry (waste, not a fault)", () => {
    const spans: SpanRecord[] = [span({ id: "root", startMin: 0, type: "agent" })];
    // fail@2 -> ok@3, fail@4 -> ok@5, fail@6 -> ok@7 (same tool + same command first token)
    for (let i = 0; i < 3; i++) {
      const base = 2 + i * 2;
      spans.push(
        span({
          id: `fail-${i}`,
          startMin: base,
          type: "tool",
          parentSpanId: "root",
          toolName: "run_python",
          toolInput: JSON.stringify({ command: "pytest tests/test_proration.py -q" }),
          toolSuccess: false,
          status: "error",
          errorMessage: "AssertionError",
        }),
        span({
          id: `ok-${i}`,
          startMin: base + 1,
          type: "tool",
          parentSpanId: "root",
          toolName: "run_python",
          toolInput: JSON.stringify({ command: "pytest tests/test_proration.py -q" }),
          toolSuccess: true,
          status: "ok",
        }),
      );
    }
    expect(run(spans, "complete")).toHaveLength(0);
  });

  it("stays quiet on a lone unrecovered error when the trace COMPLETED (intentional signal)", () => {
    // e.g. `grep -c` exit 1 = "no matches" — a single failed tool, no retry, run finished fine.
    const spans = [
      span({ id: "root", startMin: 0, type: "agent" }),
      span({
        id: "grep",
        startMin: 1,
        type: "tool",
        parentSpanId: "root",
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "grep -c needle file" }),
        toolSuccess: false,
        status: "error",
        errorMessage: "exit 1",
      }),
    ];
    expect(run(spans, "complete")).toHaveLength(0); // precision gate: not a terminal fault
  });

  it("does not treat a null-toolName tool error as recovered by an unrelated later success", () => {
    // Regression: an unidentifiable tool failure must stay live, not be silently suppressed.
    const reports = run(
      [
        span({ id: "root", startMin: 0, type: "agent" }),
        span({
          id: "t1",
          startMin: 1,
          type: "tool",
          parentSpanId: "root",
          toolSuccess: false,
          status: "error",
          errorMessage: "boom",
        }),
        span({ id: "t2", startMin: 2, type: "tool", parentSpanId: "root", toolSuccess: true }),
      ],
      "error",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.rootCauseSpanId).toBe("t1");
  });

  it("stays quiet on a clean trace", () => {
    const spans = [
      span({ id: "root", startMin: 0, type: "agent" }),
      span({ id: "llm-1", startMin: 1, type: "llm", parentSpanId: "root" }),
      span({ id: "tool-1", startMin: 2, type: "tool", parentSpanId: "root", toolSuccess: true }),
    ];
    expect(run(spans, "complete")).toHaveLength(0);
  });

  it("classifies the fault type from the root error message", () => {
    const rateLimited = run(
      [
        span({ id: "root", startMin: 0, type: "agent" }),
        span({
          id: "gen",
          startMin: 1,
          type: "llm",
          parentSpanId: "root",
          status: "error",
          errorMessage: "429 rate limit exceeded",
        }),
      ],
      "error",
    );
    expect(rateLimited[0]?.faultType).toBe("model_error");

    const timedOut = run(
      [
        span({ id: "root", startMin: 0, type: "agent" }),
        span({
          id: "tl",
          startMin: 1,
          type: "tool",
          parentSpanId: "root",
          toolName: "fetch",
          toolSuccess: false,
          status: "error",
          errorMessage: "Gateway timeout 504",
        }),
      ],
      "error",
    );
    expect(timedOut[0]?.faultType).toBe("timeout");
  });

  it("prefers a tool/retrieval origin over an llm that errored at the same time (sibling tie-break)", () => {
    const reports = run([
      span({ id: "root", startMin: 0, type: "agent" }),
      span({
        id: "llm-err",
        startMin: 5,
        type: "llm",
        parentSpanId: "root",
        status: "error",
        errorMessage: "downstream failure",
      }),
      span({
        id: "tool-err",
        startMin: 5,
        type: "tool",
        parentSpanId: "root",
        toolName: "db_query",
        toolSuccess: false,
        status: "error",
        errorMessage: "connection refused",
      }),
    ]);
    expect(reports[0]?.rootCauseSpanId).toBe("tool-err");
  });
});
