import { estimateTokenCount } from "@langcost/core";

import type { WarpConversationUsageMetadata, WarpQueryRow } from "./types";

const PRIMARY_AGENT_CATEGORY = "primary_agent";

export interface SpanTokenEstimate {
  exchangeId: string;
  inputTokens: number;
  outputTokens: number;
}

function agentOnlyTokens(metadata: WarpConversationUsageMetadata): number {
  const tokenUsage = metadata.token_usage ?? [];
  let total = 0;

  for (const entry of tokenUsage) {
    const hasPrimaryAgent =
      PRIMARY_AGENT_CATEGORY in (entry.byok_token_usage_by_category ?? {}) ||
      PRIMARY_AGENT_CATEGORY in (entry.warp_token_usage_by_category ?? {});

    if (hasPrimaryAgent) {
      total += (entry.byok_tokens ?? 0) + (entry.warp_tokens ?? 0);
    }
  }

  return total;
}

export function estimateSpanTokens(
  exchanges: WarpQueryRow[],
  metadata: WarpConversationUsageMetadata,
): SpanTokenEstimate[] {
  if (exchanges.length === 0) return [];

  const rawEstimates = exchanges.map((ex) => {
    const inputJson = ex.input ?? "[]";
    return {
      exchangeId: ex.exchange_id,
      raw: estimateTokenCount(inputJson),
    };
  });

  const totalRaw = rawEstimates.reduce((sum, e) => sum + e.raw, 0);
  const agentTotal = agentOnlyTokens(metadata);

  if (totalRaw === 0 || agentTotal === 0) {
    return exchanges.map((ex) => ({ exchangeId: ex.exchange_id, inputTokens: 0, outputTokens: 0 }));
  }

  const scale = agentTotal / totalRaw;

  return rawEstimates.map(({ exchangeId, raw }) => {
    const scaled = Math.round(raw * scale);
    // Split 80/20 input/output as a rough approximation.
    // In agentic sessions, input (cumulative context) dominates output.
    const inputTokens = Math.round(scaled * 0.8);
    const outputTokens = scaled - inputTokens;
    return { exchangeId, inputTokens, outputTokens };
  });
}
