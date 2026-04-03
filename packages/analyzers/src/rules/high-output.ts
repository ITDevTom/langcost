import type { WasteReportRecord } from "@langcost/db";

import { createWasteReport, getOutputCostUsd, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

// Tool names whose output is productive work (code edits, file writes, agent delegation)
const PRODUCTIVE_TOOLS = new Set(["Edit", "Write", "Agent", "NotebookEdit"]);

export const highOutputRule: WasteRule = {
  name: "high-output",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      // Skip traces marked as interactive/conversational by the adapter.
      // In interactive sessions, verbose output is expected (user discussions, explanations).
      // Adapters set metadata.interactive = true for such sources.
      const metadata = context.trace.metadata as Record<string, unknown> | null;
      if (metadata?.interactive === true) {
        return [];
      }

      const reports: WasteReportRecord[] = [];

      // Index tool spans by parent for quick lookup
      const toolsByParent = new Map<string, typeof context.toolSpans>();
      for (const tool of context.toolSpans) {
        if (!tool.parentSpanId) continue;
        const siblings = toolsByParent.get(tool.parentSpanId) ?? [];
        siblings.push(tool);
        toolsByParent.set(tool.parentSpanId, siblings);
      }

      for (const span of context.llmSpans) {
        const peerSpans = context.llmSpans.filter((candidate) => candidate.id !== span.id);
        if (peerSpans.length === 0 || !span.outputTokens || span.outputTokens < 100) {
          continue;
        }

        // Skip spans that have productive tool calls — high output is expected
        const childTools = toolsByParent.get(span.id) ?? [];
        const hasProductiveTools = childTools.some(
          (tool) => tool.toolName && PRODUCTIVE_TOOLS.has(tool.toolName),
        );
        if (hasProductiveTools) {
          continue;
        }

        const peerAverage =
          peerSpans.reduce((total, candidate) => total + (candidate.outputTokens ?? 0), 0) /
          peerSpans.length;

        if (peerAverage === 0 || span.outputTokens <= peerAverage * 3) {
          continue;
        }

        const excessTokens = span.outputTokens - peerAverage;
        const outputCostPerToken = getOutputCostUsd(span) / Math.max(1, span.outputTokens);
        const wastedCostUsd = excessTokens * outputCostPerToken;

        reports.push(
          createWasteReport({
            traceId: context.trace.id,
            spanId: span.id,
            category: "high_output",
            severity: severityFromCost(wastedCostUsd),
            wastedTokens: excessTokens,
            wastedCostUsd,
            description: `Span ${span.id} produced ${span.outputTokens} output tokens, more than 3x the peer average of ${peerAverage.toFixed(1)}.`,
            recommendation:
              "Consider stricter max token limits or more concise prompting for verbose turns.",
            evidence: {
              outputTokens: span.outputTokens,
              peerAverage,
            },
          }),
        );
      }

      return reports;
    });
  },
};
