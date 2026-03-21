import type { WasteReportRecord } from "@langcost/db";

import { getSpanCost, getSpanTotalTokens } from "../context";
import { createWasteReport, severityFromCost } from "./shared";
import type { WasteRule } from "./types";

function toSignature(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
  toolOutput: string | null | undefined,
): string {
  return `${toolName ?? "tool"}:${toolInput ?? ""}:${toolOutput ?? ""}`;
}

export const agentLoopsRule: WasteRule = {
  name: "agent-loops",
  tier: 1,
  detect(contexts): WasteReportRecord[] {
    return contexts.flatMap((context) => {
      const repeatedToolSpans = [];

      for (let index = 1; index < context.toolSpans.length; index += 1) {
        const previous = context.toolSpans[index - 1];
        const current = context.toolSpans[index];
        if (!previous || !current) {
          continue;
        }

        if (
          toSignature(previous.toolName, previous.toolInput, previous.toolOutput) ===
          toSignature(current.toolName, current.toolInput, current.toolOutput)
        ) {
          repeatedToolSpans.push(current);
        }
      }

      if (repeatedToolSpans.length === 0) {
        return [];
      }

      const spansById = new Map(context.spans.map((span) => [span.id, span]));
      const repeatedParentSpans = repeatedToolSpans
        .map((span) => (span.parentSpanId ? spansById.get(span.parentSpanId) : undefined))
        .filter((span): span is NonNullable<typeof span> => span !== undefined);

      const wastedCostUsd = repeatedParentSpans.reduce(
        (total, span) => total + getSpanCost(span),
        0,
      );
      const wastedTokens = repeatedParentSpans.reduce(
        (total, span) => total + getSpanTotalTokens(span),
        0,
      );
      const firstRepeatedToolSpan = repeatedToolSpans[0];
      if (!firstRepeatedToolSpan) {
        return [];
      }

      const toolName = firstRepeatedToolSpan.toolName ?? "tool";

      return [
        createWasteReport({
          traceId: context.trace.id,
          spanId: firstRepeatedToolSpan.id,
          category: "agent_loop",
          severity: severityFromCost(wastedCostUsd),
          wastedTokens,
          wastedCostUsd,
          description: `The trace repeated the ${toolName} tool pattern ${repeatedToolSpans.length + 1} times in a row.`,
          recommendation: `Add loop guards or stopping conditions around repeated ${toolName} calls.`,
          evidence: {
            repeatedToolSpanIds: repeatedToolSpans.map((span) => span.id),
            parentSpanIds: repeatedParentSpans.map((span) => span.id),
          },
        }),
      ];
    });
  },
};
