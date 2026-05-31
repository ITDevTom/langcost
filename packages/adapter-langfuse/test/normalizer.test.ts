import { describe, expect, it } from "bun:test";

import { normalizeLangfuseTrace } from "../src/normalizer";
import type { LangfuseObservation, LangfuseTrace } from "../src/types";

const trace: LangfuseTrace = {
  id: "t1",
  name: "chat-request",
  userId: "u1",
  sessionId: "s1",
  timestamp: "2026-05-29T10:00:00Z",
  tags: ["prod"],
  metadata: { feature: "support" },
  environment: "production",
};

const observations: LangfuseObservation[] = [
  {
    id: "a",
    traceId: "t1",
    parentObservationId: null,
    type: "agent",
    name: "plan",
    startTime: "2026-05-29T10:00:01Z",
  },
  {
    id: "g1",
    traceId: "t1",
    parentObservationId: "a",
    type: "GENERATION",
    name: "gen",
    model: "gpt-4o",
    startTime: "2026-05-29T10:00:02Z",
    endTime: "2026-05-29T10:00:04Z",
    input: [
      { role: "system", content: "be helpful" },
      { role: "human", content: "what's the refund policy?" },
    ],
    output: { role: "assistant", content: "90 days" },
    usageDetails: { input: 100, output: 20, cache_read_input_tokens: 80 },
    costDetails: { total: 0.01 },
    level: "DEFAULT",
  },
  {
    id: "r",
    traceId: "t1",
    parentObservationId: "a",
    type: "retriever",
    name: "kb-search",
    startTime: "2026-05-29T10:00:03Z",
    output: [],
    metadata: { docCount: 0 },
  },
  {
    id: "tl",
    traceId: "t1",
    parentObservationId: "a",
    type: "tool",
    name: "run_sql",
    startTime: "2026-05-29T10:00:05Z",
    input: { query: "select 1" },
    output: "connection refused",
    level: "ERROR",
    statusMessage: "boom",
  },
  {
    id: "c",
    traceId: "t1",
    parentObservationId: "a",
    type: "chain",
    name: "router",
    startTime: "2026-05-29T10:00:06Z",
  },
  // generation with no costDetails → cost falls back to core pricing (gpt-4o is priced)
  {
    id: "g2",
    traceId: "t1",
    parentObservationId: "a",
    type: "generation",
    model: "gpt-4o",
    startTime: "2026-05-29T10:00:07Z",
    usageDetails: { input: 1000, output: 100 },
  },
];

describe("normalizeLangfuseTrace", () => {
  const { trace: t, spans, messages } = normalizeLangfuseTrace(trace, observations);
  const byExternal = new Map(spans.map((s) => [s.externalId, s]));

  it("namespaces ids and maps trace fields", () => {
    expect(t.id).toBe("langfuse:t1");
    expect(t.externalId).toBe("t1");
    expect(t.source).toBe("langfuse");
    expect(t.sessionKey).toBe("s1");
    expect(t.status).toBe("error"); // tool errored
    expect(t.model).toBe("gpt-4o");
    expect(t.metadata).toMatchObject({
      name: "chat-request",
      userId: "u1",
      feature: "support",
      environment: "production",
    });
    expect(t.metadata?.tags).toEqual(["prod"]);
  });

  it("maps observation types (generation/embedding→llm, tool, retriever, agent; chain/SPAN→agent)", () => {
    expect(byExternal.get("g1")?.type).toBe("llm");
    expect(byExternal.get("tl")?.type).toBe("tool");
    expect(byExternal.get("r")?.type).toBe("retrieval");
    expect(byExternal.get("a")?.type).toBe("agent");
    expect(byExternal.get("c")?.type).toBe("agent"); // chain → generic agent bucket
    expect(byExternal.get("c")?.metadata?.langfuseType).toBe("chain"); // original preserved
  });

  it("preserves nesting via parentSpanId", () => {
    expect(byExternal.get("g1")?.parentSpanId).toBe("langfuse:a");
    expect(byExternal.get("a")?.parentSpanId).toBeNull();
  });

  it("lifts cache_read_input_tokens into metadata.cacheRead (feeds low-cache)", () => {
    expect(byExternal.get("g1")?.metadata?.cacheRead).toBe(80);
  });

  it("uses Langfuse cost when present, falls back to core pricing otherwise", () => {
    expect(byExternal.get("g1")?.costUsd).toBe(0.01); // from costDetails.total
    const g2 = byExternal.get("g2");
    expect(g2?.costUsd).not.toBeNull(); // computed via calculateCost (gpt-4o priced)
    expect(g2?.costUsd ?? 0).toBeGreaterThan(0);
  });

  it("maps tool fields + error status", () => {
    const tool = byExternal.get("tl");
    expect(tool?.toolName).toBe("run_sql");
    expect(tool?.toolInput).toContain("select 1");
    expect(tool?.toolOutput).toBe("connection refused");
    expect(tool?.toolSuccess).toBe(false);
    expect(tool?.status).toBe("error");
    expect(tool?.errorMessage).toBe("boom");
  });

  it("parses chat input/output into ordered messages (with role normalization)", () => {
    const msgs = messages.filter((m) => m.spanId === "langfuse:g1");
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant"]); // "human" → user
    expect(msgs[1]?.content).toContain("refund policy");
    expect(msgs[2]?.content).toContain("90 days");
  });

  it("rolls up trace totals from llm spans only", () => {
    expect(t.totalInputTokens).toBe(1100); // g1 100 + g2 1000
    expect(t.totalOutputTokens).toBe(120); // g1 20 + g2 100
    expect(t.totalCostUsd).toBeGreaterThan(0.01);
  });
});
