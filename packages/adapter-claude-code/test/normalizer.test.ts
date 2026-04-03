import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { readConversationFile } from "../src/reader";
import { normalizeConversation } from "../src/normalizer";
import type { DiscoveredConversationFile } from "../src/types";

function makeConversationFile(
  fixtureName: string,
  overrides?: Partial<DiscoveredConversationFile>,
): DiscoveredConversationFile {
  return {
    filePath: join(process.cwd(), "fixtures", "claude-code", fixtureName),
    fileSize: 0,
    modifiedAt: new Date("2026-04-01T10:00:00.000Z"),
    conversationId: fixtureName.replace(".jsonl", ""),
    project: {
      projectPath: "-Users-test-project",
      projectName: "project",
      originalPath: "/Users/test/project",
    },
    ...overrides,
  };
}

async function normalizeFixture(fixtureName: string) {
  const conversationFile = makeConversationFile(fixtureName);
  const readResult = await readConversationFile(conversationFile.filePath);
  return normalizeConversation(conversationFile, readResult);
}

describe("normalizeConversation", () => {
  describe("simple conversation", () => {
    it("creates a trace with correct metadata", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");

      expect(result.trace.source).toBe("claude-code");
      expect(result.trace.model).toBe("claude-sonnet-4-6");
      expect(result.trace.status).toBe("complete");
      expect(result.trace.metadata?.project).toBe("project");
      expect(result.trace.metadata?.projectPath).toBe("/Users/test/project");
      expect(result.trace.metadata?.gitBranch).toBe("main");
      expect(result.trace.metadata?.version).toBe("2.1.91");
    });

    it("creates LLM spans for each assistant turn", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");
      const llmSpans = result.spans.filter((s) => s.type === "llm");

      expect(llmSpans).toHaveLength(2);
      expect(llmSpans[0]?.model).toBe("claude-sonnet-4-6");
      expect(llmSpans[1]?.model).toBe("claude-sonnet-4-6");
    });

    it("records messages in order", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");

      expect(result.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(result.messages[0]?.content).toBe("What is 2 + 2?");
      expect(result.messages[1]?.content).toBe("2 + 2 = 4");
    });

    it("accumulates turn duration from system entries", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");

      expect(result.trace.metadata?.totalDurationMs).toBe(6000);
    });

    it("calculates cost from input + output only (no cache)", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");

      // Sonnet pricing: $3/M input, $15/M output
      // Turn 1: input=50, output=10
      // Turn 2: input=60, output=12
      // Cost = (110 / 1M * 3) + (22 / 1M * 15) = negligible but > 0
      expect(result.trace.totalCostUsd).toBeGreaterThan(0);
      expect(result.trace.totalInputTokens).toBe(50 + 60);
      expect(result.trace.totalOutputTokens).toBe(10 + 12);
    });

    it("stores cache token totals in trace metadata", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");

      // Turn 1: cacheWrite=1000, cacheRead=5000
      // Turn 2: cacheWrite=200, cacheRead=6000
      expect(result.trace.metadata?.totalCacheCreationTokens).toBe(1200);
      expect(result.trace.metadata?.totalCacheReadTokens).toBe(11000);
    });
  });

  describe("streaming deduplication", () => {
    it("keeps only the final assistant entry per requestId", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");
      const llmSpans = result.spans.filter((s) => s.type === "llm");

      // 3 streaming entries for req_01 → 1 kept, plus 1 for req_02 = 2 total
      expect(llmSpans).toHaveLength(2);
    });

    it("picks the entry with stop_reason over streaming intermediates", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");
      const llmSpans = result.spans.filter((s) => s.type === "llm");

      expect(llmSpans[0]?.metadata?.stopReason).toBe("tool_use");
      expect(llmSpans[1]?.metadata?.stopReason).toBe("end_turn");
    });

    it("counts tokens only once after dedup", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");

      // req_01 (deduped): input=3, output=40
      // req_02: input=80, output=25
      // Only non-cached input tokens in headline
      expect(result.trace.totalInputTokens).toBe(3 + 80);
      expect(result.trace.totalOutputTokens).toBe(40 + 25);
    });
  });

  describe("tool use and tool results", () => {
    it("creates tool spans from tool_use blocks", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");
      const toolSpans = result.spans.filter((s) => s.type === "tool");

      expect(toolSpans).toHaveLength(1);
      expect(toolSpans[0]?.toolName).toBe("Bash");
      expect(toolSpans[0]?.toolInput).toContain("ls -la");
    });

    it("pairs tool results with tool_use spans", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");
      const toolSpan = result.spans.find((s) => s.type === "tool");

      expect(toolSpan?.toolOutput).toContain("file1.ts");
      expect(toolSpan?.toolSuccess).toBe(true);
      expect(toolSpan?.status).toBe("ok");
    });

    it("marks failed tool calls as errors", async () => {
      const result = await normalizeFixture("tool-error.jsonl");
      const toolSpan = result.spans.find((s) => s.type === "tool");

      expect(toolSpan?.toolName).toBe("Bash");
      expect(toolSpan?.toolSuccess).toBe(false);
      expect(toolSpan?.status).toBe("error");
      expect(toolSpan?.toolOutput).toContain("exit code 1");
    });

    it("marks trace as error when tool calls fail", async () => {
      const result = await normalizeFixture("tool-error.jsonl");

      expect(result.trace.status).toBe("error");
    });

    it("creates tool messages on the tool span", async () => {
      const result = await normalizeFixture("with-streaming-dupes.jsonl");
      const toolSpan = result.spans.find((s) => s.type === "tool");
      const toolMessages = result.messages.filter((m) => m.spanId === toolSpan?.id);

      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.role).toBe("tool");
      expect(toolMessages[0]?.content).toContain("file1.ts");
    });
  });

  describe("edge cases", () => {
    it("generates no errors for valid fixtures", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");
      expect(result.errors).toHaveLength(0);
    });

    it("sets provider to anthropic for all LLM spans", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");
      const llmSpans = result.spans.filter((s) => s.type === "llm");

      for (const span of llmSpans) {
        expect(span.provider).toBe("anthropic");
      }
    });

    it("stores cache token breakdown in span metadata", async () => {
      const result = await normalizeFixture("simple-conversation.jsonl");
      const firstLlm = result.spans.find((s) => s.type === "llm");

      expect(firstLlm?.metadata?.cacheCreationTokens).toBe(1000);
      expect(firstLlm?.metadata?.cacheReadTokens).toBe(5000);
    });
  });
});
