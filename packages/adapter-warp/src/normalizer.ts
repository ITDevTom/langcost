import { calculateCost, estimateTokenCount } from "@langcost/core";
import type { MessageRecord, SpanRecord, TraceRecord } from "@langcost/db";

import { normalizeModelId } from "./model-map";
import { estimateSpanTokens } from "./token-estimator";
import type {
  WarpBlockMetadata,
  WarpBlockRow,
  WarpConversationData,
  WarpConversationRow,
  WarpInputEntry,
  WarpQueryRow,
  WarpTokenUsageEntry,
} from "./types";

export interface NormalizedConversation {
  trace: TraceRecord;
  spans: SpanRecord[];
  messages: MessageRecord[];
}

// ── ANSI stripping ──

const ANSI_CSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(bytes: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return "";
  return new TextDecoder().decode(bytes).replace(ANSI_CSI, "");
}

// ── output_status parsing ──
// Values are stored as JSON-quoted strings: '"Completed"', '"Cancelled"', '"Failed"'

function parseOutputStatus(raw: string): "ok" | "error" | "partial" {
  let value = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") value = parsed;
  } catch {}

  if (value === "Completed") return "ok";
  if (value === "Failed") return "error";
  return "partial"; // Cancelled or unknown
}

// ── Timestamp parsing ──

function parseTs(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

// ── ID helpers ──

function traceId(conversationId: string): string {
  return `warp:trace:${conversationId}`;
}

function llmSpanId(conversationId: string, exchangeId: string): string {
  return `warp:span:llm:${conversationId}:${exchangeId}`;
}

function toolSpanId(blockId: string): string {
  return `warp:span:tool:${blockId}`;
}

function messageId(spanId: string, position: number): string {
  return `${spanId}:msg:${position}`;
}

// ── Token / cost helpers ──

function totalTokensAllModels(entries: WarpTokenUsageEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.byok_tokens ?? 0) + (e.warp_tokens ?? 0), 0);
}

function primaryModel(entries: WarpTokenUsageEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return [...entries].sort(
    (a, b) =>
      (b.byok_tokens ?? 0) + (b.warp_tokens ?? 0) - ((a.byok_tokens ?? 0) + (a.warp_tokens ?? 0)),
  )[0]?.model_id;
}

// ── Input text extraction ──

function extractUserText(inputJson: string): string {
  try {
    const entries = JSON.parse(inputJson) as WarpInputEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return "";
    return entries[0]?.Query?.text ?? "";
  } catch {
    return "";
  }
}

// ── Parent LLM span attribution for tool blocks ──
// A block belongs to the LLM exchange with the highest start_ts < block.start_ts.

function attributeBlockToExchange(
  blockStartMs: number,
  exchangeTimestamps: { exchangeId: string; startMs: number }[],
): string | undefined {
  let best: string | undefined;
  let bestMs = -1;

  for (const { exchangeId, startMs } of exchangeTimestamps) {
    if (startMs < blockStartMs && startMs > bestMs) {
      best = exchangeId;
      bestMs = startMs;
    }
  }

  return best;
}

// ── Main normalizer ──

export function normalizeConversation(
  conv: WarpConversationRow,
  exchanges: WarpQueryRow[],
  blocks: WarpBlockRow[],
): NormalizedConversation {
  const tid = traceId(conv.conversation_id);
  const spans: SpanRecord[] = [];
  const messages: MessageRecord[] = [];

  // Parse conversation metadata
  let convData: WarpConversationData = {};
  try {
    convData = JSON.parse(conv.conversation_data) as WarpConversationData;
  } catch {}

  const usageMeta = convData.conversation_usage_metadata ?? {};
  const tokenUsage = usageMeta.token_usage ?? [];
  const totalTokens = totalTokensAllModels(tokenUsage);
  const dominantModel = primaryModel(tokenUsage);
  const creditsSpent = usageMeta.credits_spent ?? 0;
  const totalCostUsd = dominantModel
    ? calculateCost(normalizeModelId(dominantModel), totalTokens, 0).totalCost
    : 0;

  // Estimate per-span tokens (primary_agent only, normalized)
  const tokenEstimates = estimateSpanTokens(exchanges, usageMeta);
  const tokenEstimateMap = new Map(tokenEstimates.map((e) => [e.exchangeId, e]));

  // Build exchange timestamps for block attribution
  const exchangeTimestamps = exchanges.map((ex) => ({
    exchangeId: ex.exchange_id,
    startMs: parseTs(ex.start_ts)?.getTime() ?? 0,
  }));

  // Track per-span message position counters
  const positionCounter = new Map<string, number>();
  const nextPosition = (spanId: string): number => {
    const pos = positionCounter.get(spanId) ?? 0;
    positionCounter.set(spanId, pos + 1);
    return pos;
  };

  let hasError = false;
  let hasPartial = false;

  // ── LLM spans ──
  for (const ex of exchanges) {
    const spanId = llmSpanId(conv.conversation_id, ex.exchange_id);
    const startedAt = parseTs(ex.start_ts) ?? new Date(conv.last_modified_at);
    const status = parseOutputStatus(ex.output_status);
    const model = normalizeModelId(ex.model_id);
    const tokens = tokenEstimateMap.get(ex.exchange_id);
    const inputTokens = tokens?.inputTokens ?? 0;
    const outputTokens = tokens?.outputTokens ?? 0;
    const costUsd = calculateCost(model, inputTokens, outputTokens).totalCost;

    if (status === "error") hasError = true;
    if (status === "partial") hasPartial = true;

    spans.push({
      id: spanId,
      traceId: tid,
      parentSpanId: null,
      externalId: ex.exchange_id,
      type: "llm",
      name: "assistant",
      startedAt,
      endedAt: startedAt,
      durationMs: null,
      model,
      provider: "anthropic",
      inputTokens,
      outputTokens,
      costUsd,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      toolSuccess: null,
      status,
      errorMessage: status === "error" ? `output_status: ${ex.output_status}` : null,
      metadata: {
        estimatedTokens: true,
        workingDirectory: ex.working_directory ?? null,
        rawModelId: ex.model_id,
      },
    });

    // User message from input text
    const userText = extractUserText(ex.input);
    if (userText.length > 0) {
      messages.push({
        id: messageId(spanId, nextPosition(spanId)),
        spanId,
        traceId: tid,
        role: "user",
        content: userText,
        tokenCount: estimateTokenCount(userText),
        position: positionCounter.get(spanId)! - 1,
        metadata: null,
      });
    }
  }

  // ── Tool spans (run_command blocks) ──
  for (const block of blocks) {
    let blockMeta: WarpBlockMetadata = {};
    try {
      blockMeta = JSON.parse(block.ai_metadata) as WarpBlockMetadata;
    } catch {
      continue;
    }

    const toolUseId = blockMeta.requested_command_action_id;
    if (!toolUseId) continue;

    const blockStartMs = parseTs(block.start_ts)?.getTime() ?? 0;
    const parentExchangeId = attributeBlockToExchange(blockStartMs, exchangeTimestamps);
    const parentSpanId = parentExchangeId
      ? llmSpanId(conv.conversation_id, parentExchangeId)
      : null;

    const startedAt = parseTs(block.start_ts) ?? new Date(conv.last_modified_at);
    const endedAt = parseTs(block.completed_ts) ?? startedAt;
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

    const commandText = stripAnsi(block.stylized_command);
    const outputText = stripAnsi(block.stylized_output);
    const success = block.exit_code === 0;
    const spanId = toolSpanId(block.block_id);

    spans.push({
      id: spanId,
      traceId: tid,
      parentSpanId,
      externalId: toolUseId,
      type: "tool",
      name: "run_command",
      startedAt,
      endedAt,
      durationMs,
      model: null,
      provider: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      toolName: "run_command",
      toolInput: commandText || null,
      toolOutput: outputText || null,
      toolSuccess: success,
      status: success ? "ok" : "error",
      errorMessage: success ? null : `exit_code: ${block.exit_code}`,
      metadata: {
        blockId: block.block_id,
        toolUseId,
        exitCode: block.exit_code,
        subagentTaskId: blockMeta.subagent_task_id ?? null,
      },
    });

    if (!success) hasError = true;

    // Tool result message
    if (outputText.length > 0) {
      messages.push({
        id: messageId(spanId, nextPosition(spanId)),
        spanId,
        traceId: tid,
        role: "tool",
        content: outputText,
        tokenCount: estimateTokenCount(outputText),
        position: positionCounter.get(spanId)! - 1,
        metadata: { exitCode: block.exit_code },
      });
    }
  }

  // ── Trace ──
  const startedAt =
    parseTs(exchanges[0]?.start_ts) ?? parseTs(conv.last_modified_at) ?? new Date();
  const endedAt = parseTs(conv.last_modified_at) ?? startedAt;

  const trace: TraceRecord = {
    id: tid,
    externalId: conv.conversation_id,
    source: "warp",
    sessionKey: conv.conversation_id,
    startedAt,
    endedAt,
    totalInputTokens: totalTokens,
    totalOutputTokens: 0,
    totalCostUsd,
    ...(dominantModel ? { model: normalizeModelId(dominantModel) } : {}),
    status: hasError ? "error" : hasPartial ? "partial" : "complete",
    metadata: {
      creditsSpent,
      estimatedCost: true,
      toolUsageMetadata: usageMeta.tool_usage_metadata ?? null,
      wasSummarized: usageMeta.was_summarized ?? false,
      contextWindowUsage: usageMeta.context_window_usage ?? null,
      runId: convData.run_id ?? null,
    },
    ingestedAt: new Date(),
  };

  return { trace, spans, messages };
}
