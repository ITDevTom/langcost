import type { WasteReportRecord } from "@langcost/db";

import { jaccardSimilarity, createWasteReport, severityFromCost } from "./shared";
import type { ResolvedRuleConfig, WasteRule } from "./types";

const PRODUCTIVE_TOOL_NAMES = new Set(["Edit", "Write", "NotebookEdit", "Agent"]);

function getSpanMessagesContent(
  messagesBySpanId: Map<string, string[]>,
  spanId: string | null | undefined,
): string {
  if (!spanId) {
    return "";
  }
  return (messagesBySpanId.get(spanId) ?? []).join("\n").trim();
}

export const unusedToolsRule: WasteRule = {
  id: "unused-tools",
  tier: 1,
  title: "Unused tool output",
  description: "Large tool outputs that appear not to influence subsequent model or tool work.",
  defaultEnabled: false,
  defaultThresholds: {
    minToolResultTokens: 2_000,
    maxSimilarity: 0.08,
  },
  detect(contexts, config?: ResolvedRuleConfig): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const minToolResultTokens = Math.max(1, config?.thresholds.minToolResultTokens ?? 2_000);
      const maxSimilarity = Math.max(0, config?.thresholds.maxSimilarity ?? 0.08);

      const messagesBySpanId = new Map<string, string[]>();
      for (const message of context.messages) {
        const current = messagesBySpanId.get(message.spanId) ?? [];
        current.push(message.content);
        messagesBySpanId.set(message.spanId, current);
      }

      const flagged: Array<{
        toolSpanId: string;
        toolName: string | null;
        nextLlmSpanId: string | null;
        toolResultTokens: number;
        toolResultCostUsd: number;
        similarityScore: number;
      }> = [];

      for (const tool of context.toolSpans) {
        if (tool.status === "error" || tool.toolSuccess === false) {
          continue;
        }

        if (tool.toolName && PRODUCTIVE_TOOL_NAMES.has(tool.toolName)) {
          continue;
        }

        const toolResultSegments = context.segments.filter(
          (segment) => segment.spanId === tool.id && segment.type === "tool_result",
        );
        if (toolResultSegments.length === 0) {
          continue;
        }

        const toolResultTokens = toolResultSegments.reduce((sum, segment) => sum + segment.tokenCount, 0);
        if (toolResultTokens < minToolResultTokens) {
          continue;
        }

        const toolResultCostUsd = toolResultSegments.reduce((sum, segment) => sum + segment.costUsd, 0);
        const outputText =
          (tool.toolOutput ?? "").trim() || getSpanMessagesContent(messagesBySpanId, tool.id);
        if (outputText.length === 0) {
          continue;
        }

        const nextLlm = context.llmSpans.find(
          (span) => span.startedAt.getTime() > tool.startedAt.getTime(),
        );
        if (!nextLlm) {
          continue;
        }

        const nextLlmText = getSpanMessagesContent(messagesBySpanId, nextLlm.id);
        const nextTool = context.toolSpans.find(
          (candidate) => candidate.startedAt.getTime() > tool.startedAt.getTime(),
        );
        const nextToolInput = (nextTool?.toolInput ?? "").trim();

        const similarityWithNextLlm = nextLlmText.length > 0 ? jaccardSimilarity(outputText, nextLlmText) : 0;
        const similarityWithNextToolInput =
          nextToolInput.length > 0 ? jaccardSimilarity(outputText, nextToolInput) : 0;
        const similarityScore = Math.max(similarityWithNextLlm, similarityWithNextToolInput);

        if (similarityScore > maxSimilarity) {
          continue;
        }

        flagged.push({
          toolSpanId: tool.id,
          toolName: tool.toolName ?? null,
          nextLlmSpanId: nextLlm.id,
          toolResultTokens,
          toolResultCostUsd,
          similarityScore,
        });
      }

      if (flagged.length === 0) {
        return [];
      }

      const wastedTokens = flagged.reduce((sum, entry) => sum + entry.toolResultTokens, 0);
      const wastedCostUsd = flagged.reduce((sum, entry) => sum + entry.toolResultCostUsd, 0);
      const first = flagged[0];
      if (!first) {
        return [];
      }

      return [
        createWasteReport({
          traceId: context.trace.id,
          spanId: first.toolSpanId,
          category: "unused_tools",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `${flagged.length} large tool output(s) showed very low overlap with subsequent model/tool usage.`,
          recommendation:
            "Narrow tool queries, limit output size, and avoid broad reads/searches unless the result is directly used in the next step.",
          evidence: {
            toolSpanIds: flagged.map((entry) => entry.toolSpanId),
            toolNames: flagged.map((entry) => entry.toolName),
            nextLlmSpanIds: flagged.map((entry) => entry.nextLlmSpanId),
            toolResultTokenCounts: flagged.map((entry) => entry.toolResultTokens),
            similarityScores: flagged.map((entry) => entry.similarityScore),
            thresholds: {
              minToolResultTokens,
              maxSimilarity,
            },
          },
        }),
      ];
    });
  },
};
