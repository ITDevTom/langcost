import { describe, expect, it } from "bun:test";
import type { SpanRecord, TraceRecord } from "@langcost/db";

import { buildTraceContext } from "../src/context";
import { silentToolMisuseRule } from "../src/rules/fault/silent-tool-misuse";

const TRACE_ID = "trace-silent";

function makeTrace(status: TraceRecord["status"] = "complete"): TraceRecord {
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

function run(spans: SpanRecord[], status: TraceRecord["status"] = "complete") {
  return silentToolMisuseRule.detect([buildTraceContext(makeTrace(status), spans, [], [])]);
}

describe("silentToolMisuseRule — corrupt-output attribution across the ok→error boundary", () => {
  it("flags a success-but-empty tool followed by a downstream error in a COMPLETE trace", () => {
    const reports = run(
      [
        span({ id: "root", startMin: 0, type: "agent" }),
        span({
          id: "search",
          startMin: 1,
          type: "tool",
          parentSpanId: "root",
          toolName: "vector_search",
          toolInput: JSON.stringify({ query: "refund policy" }),
          toolSuccess: true,
          status: "ok",
          toolOutput: "[]", // green status, junk payload
        }),
        span({
          id: "synthesize",
          startMin: 2,
          type: "llm",
          parentSpanId: "root",
          status: "error",
          errorMessage: "cannot summarize empty context",
        }),
      ],
      "complete", // the whole point: trace finished "successfully"
    );

    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r?.rootCauseSpanId).toBe("search"); // the silent tool, not the symptom
    expect(r?.faultSpanId).toBe("synthesize"); // the downstream errored span
    expect(r?.faultType).toBe("upstream_data");
    expect(r?.confidence).toBe("high"); // confirmed by a downstream error
    expect(r?.severity).toBe("high");
    expect(r?.cascadeDepth).toBe(2);
    expect(r?.affectedSpanIds).toEqual(["search", "synthesize"]);
  });

  it("flags a success-but-empty tool that is immediately retried (no downstream error) at medium confidence", () => {
    const reports = run([
      span({ id: "root", startMin: 0, type: "agent" }),
      span({
        id: "ls-1",
        startMin: 1,
        type: "tool",
        parentSpanId: "root",
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "ls build/" }),
        toolSuccess: true,
        status: "ok",
        toolOutput: "   ", // whitespace-only = corrupt
      }),
      span({
        id: "ls-2",
        startMin: 2,
        type: "tool",
        parentSpanId: "root",
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "ls build/dist" }),
        toolSuccess: true,
        status: "ok",
        toolOutput: "main.js\nmain.css",
      }),
    ]);

    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r?.rootCauseSpanId).toBe("ls-1");
    expect(r?.faultSpanId).toBe("ls-1"); // no downstream error -> the tool itself
    expect(r?.faultType).toBe("upstream_data");
    expect(r?.confidence).toBe("medium"); // retry-only heuristic
    expect(r?.severity).toBe("medium");
    expect(r?.cascadeDepth).toBe(1);
    expect(r?.affectedSpanIds).toEqual(["ls-1"]);
  });

  it("stays quiet when a corrupt-output tool has NO downstream consequence (precision)", () => {
    const reports = run([
      span({ id: "root", startMin: 0, type: "agent" }),
      span({
        id: "search",
        startMin: 1,
        type: "tool",
        parentSpanId: "root",
        toolName: "vector_search",
        toolSuccess: true,
        status: "ok",
        toolOutput: "no results", // empty, but the agent handled it fine
      }),
      span({
        id: "reply",
        startMin: 2,
        type: "llm",
        parentSpanId: "root",
        status: "ok", // no downstream error, no retry
      }),
    ]);
    expect(reports).toHaveLength(0);
  });

  it("stays quiet on a tool that returned a normal non-empty output", () => {
    const reports = run([
      span({ id: "root", startMin: 0, type: "agent" }),
      span({
        id: "search",
        startMin: 1,
        type: "tool",
        parentSpanId: "root",
        toolName: "db_query",
        toolSuccess: true,
        status: "ok",
        toolOutput: JSON.stringify([{ id: 1, name: "Acme" }]),
      }),
      span({
        id: "downstream",
        startMin: 2,
        type: "llm",
        parentSpanId: "root",
        status: "error",
        errorMessage: "unrelated model error",
      }),
    ]);
    // The tool output was valid, so this rule must not claim it — even though a later span errored.
    expect(reports).toHaveLength(0);
  });

  it("does NOT pick up a hard-errored tool (rule #1's territory)", () => {
    const reports = run(
      [
        span({ id: "root", startMin: 0, type: "agent" }),
        span({
          id: "search",
          startMin: 1,
          type: "tool",
          parentSpanId: "root",
          toolName: "vector_search",
          toolSuccess: false, // hard failure
          status: "error",
          errorMessage: "connection refused",
          toolOutput: "[]", // even with empty output, status!=ok excludes it
        }),
        span({
          id: "synthesize",
          startMin: 2,
          type: "llm",
          parentSpanId: "root",
          status: "error",
          errorMessage: "downstream",
        }),
      ],
      "error",
    );
    expect(reports).toHaveLength(0);
  });
});
