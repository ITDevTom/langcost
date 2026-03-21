import type { IngestError, Message } from "@langcost/core";
import { calculateCost, estimateTokenCount } from "@langcost/core";
import type { MessageRecord, SpanRecord, TraceRecord } from "@langcost/db";

import type {
  DiscoveredSessionFile,
  OpenClawAssistantMessage,
  OpenClawCompactionEntry,
  OpenClawContentBlock,
  OpenClawEntry,
  OpenClawImageBlock,
  OpenClawMessageEntry,
  OpenClawModelChangeEntry,
  OpenClawSessionEntry,
  OpenClawTextBlock,
  OpenClawThinkingBlock,
  OpenClawToolCallBlock,
  OpenClawToolResultMessage,
  OpenClawUsage,
  ReadSessionResult,
} from "./types";

export interface NormalizedSession {
  trace: TraceRecord;
  spans: SpanRecord[];
  messages: MessageRecord[];
  errors: IngestError[];
}

function toTraceId(sessionId: string): string {
  return `openclaw:trace:${sessionId}`;
}

function toLlmSpanId(traceId: string, index: number): string {
  return `${traceId}:llm:${index}`;
}

function toToolSpanId(traceId: string, toolCallId: string): string {
  return `${traceId}:tool:${toolCallId}`;
}

function toMessageId(spanId: string, position: number): string {
  return `${spanId}:message:${position}`;
}

function parseTimestamp(value?: string | number | null): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return undefined;
}

function isSessionEntry(entry: OpenClawEntry): entry is OpenClawSessionEntry {
  return entry.type === "session" && typeof (entry as { id?: unknown }).id === "string";
}

function isMessageEntry(entry: OpenClawEntry): entry is OpenClawMessageEntry {
  return (
    entry.type === "message" &&
    typeof (entry as { message?: unknown }).message === "object" &&
    (entry as { message?: unknown }).message !== null
  );
}

function isModelChangeEntry(entry: OpenClawEntry): entry is OpenClawModelChangeEntry {
  return entry.type === "model_change";
}

function isCompactionEntry(entry: OpenClawEntry): entry is OpenClawCompactionEntry {
  return entry.type === "compaction";
}

function isTextBlock(block: OpenClawContentBlock): block is OpenClawTextBlock {
  return block.type === "text";
}

function isThinkingBlock(block: OpenClawContentBlock): block is OpenClawThinkingBlock {
  return block.type === "thinking";
}

function isToolCallBlock(block: OpenClawContentBlock): block is OpenClawToolCallBlock {
  return block.type === "toolCall";
}

function isImageBlock(block: OpenClawContentBlock): block is OpenClawImageBlock {
  return block.type === "image";
}

function isAssistantMessage(
  message: OpenClawMessageEntry["message"],
): message is OpenClawAssistantMessage {
  return message.role === "assistant";
}

function isToolResultMessage(
  message: OpenClawMessageEntry["message"],
): message is OpenClawToolResultMessage {
  return message.role === "toolResult";
}

function extractEntryTimestamp(entry: OpenClawEntry): Date | undefined {
  if (isMessageEntry(entry)) {
    return parseTimestamp(entry.message.timestamp) ?? parseTimestamp(entry.timestamp);
  }

  return parseTimestamp(entry.timestamp);
}

function flattenContent(content?: OpenClawContentBlock[] | string): string {
  if (typeof content === "string") {
    return content;
  }

  if (!content || content.length === 0) {
    return "";
  }

  return content
    .map((block) => {
      if (isTextBlock(block)) {
        return block.text ?? "";
      }

      if (isThinkingBlock(block)) {
        return block.thinking ?? block.text ?? "";
      }

      if (isToolCallBlock(block)) {
        return `[tool:${block.name ?? "unknown"}] ${JSON.stringify(block.arguments ?? {})}`;
      }

      if (isImageBlock(block)) {
        return `[image:${block.mimeType ?? block.mediaType ?? "unknown"}]`;
      }

      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function extractToolCalls(content?: OpenClawContentBlock[] | string): OpenClawToolCallBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(isToolCallBlock);
}

function serializeValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function getUsageTotals(
  usage: OpenClawUsage | undefined,
  model: string | undefined,
  inputContent: string,
  outputContent: string,
) {
  const hasUsage = usage !== undefined;
  const inputTokens = usage?.input ?? estimateTokenCount(inputContent);
  const outputTokens = usage?.output ?? estimateTokenCount(outputContent);

  if (usage?.cost?.total !== undefined) {
    return {
      costUsd: usage.cost.total,
      estimated: !hasUsage,
    };
  }

  const calculated = model ? calculateCost(model, inputTokens, outputTokens) : { totalCost: 0 };
  return {
    costUsd: calculated.totalCost,
    estimated: !hasUsage || usage?.cost?.total === undefined,
  };
}

function buildMessage(
  spanId: string,
  traceId: string,
  role: Message["role"],
  content: string,
  position: number,
  metadata?: Record<string, unknown>,
): MessageRecord {
  return {
    id: toMessageId(spanId, position),
    spanId,
    traceId,
    role,
    content,
    tokenCount: content.length > 0 ? estimateTokenCount(content) : 0,
    position,
    metadata: metadata ?? null,
  };
}

export function normalizeSession(
  sessionFile: DiscoveredSessionFile,
  readResult: ReadSessionResult,
): NormalizedSession {
  const traceId = toTraceId(sessionFile.sessionId);
  const spans: SpanRecord[] = [];
  const messages: MessageRecord[] = [];
  const errors: IngestError[] = readResult.errors.map((error) => ({
    file: sessionFile.filePath,
    line: error.line,
    message: error.message,
  }));

  let sessionHeader: OpenClawSessionEntry | undefined;
  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  let lastActivityAt = sessionFile.modifiedAt;
  let hasError = false;
  let isPartial = errors.length > 0;
  let llmIndex = 0;
  let orphanToolIndex = 0;
  let compactionCount = 0;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  let lastLlmSpanId: string | undefined;
  const pendingUserEntries: OpenClawMessageEntry[] = [];
  const toolSpanIdsByCallId = new Map<string, string>();
  const spanIndexesById = new Map<string, number>();
  const positionsBySpanId = new Map<string, number>();

  function nextPosition(spanId: string): number {
    const current = positionsBySpanId.get(spanId) ?? 0;
    positionsBySpanId.set(spanId, current + 1);
    return current;
  }

  function addSpan(span: SpanRecord): void {
    spanIndexesById.set(span.id, spans.length);
    spans.push(span);
  }

  function replaceSpan(span: SpanRecord): void {
    const index = spanIndexesById.get(span.id);
    if (index === undefined) {
      addSpan(span);
      return;
    }

    spans[index] = span;
  }

  for (const entry of readResult.entries) {
    const timestamp = extractEntryTimestamp(entry) ?? lastActivityAt;
    if (timestamp.getTime() > lastActivityAt.getTime()) {
      lastActivityAt = timestamp;
    }

    if (isSessionEntry(entry)) {
      sessionHeader = entry;
      currentModel = entry.modelId ?? currentModel;
      currentProvider = entry.provider ?? currentProvider;
      continue;
    }

    if (isModelChangeEntry(entry)) {
      currentModel = entry.modelId ?? entry.model ?? currentModel;
      currentProvider = entry.provider ?? currentProvider;
      continue;
    }

    if (isCompactionEntry(entry)) {
      compactionCount += 1;
      continue;
    }

    if (!isMessageEntry(entry)) {
      continue;
    }

    const messageEntry = entry;
    const role = messageEntry.message.role;

    if (role === "user") {
      pendingUserEntries.push(messageEntry);
      continue;
    }

    if (isAssistantMessage(messageEntry.message)) {
      const assistantMessage = messageEntry.message;
      const model = assistantMessage.model ?? currentModel ?? sessionHeader?.modelId;
      const provider = assistantMessage.provider ?? currentProvider ?? sessionHeader?.provider;
      const assistantContent = flattenContent(assistantMessage.content);
      const pendingUserContent = pendingUserEntries
        .map((pending) => flattenContent(pending.message.content))
        .join("\n");
      const usageTotals = getUsageTotals(
        assistantMessage.usage,
        model,
        pendingUserContent,
        assistantContent,
      );

      currentModel = model ?? currentModel;
      currentProvider = provider ?? currentProvider;
      llmIndex += 1;
      const spanId = toLlmSpanId(traceId, llmIndex);
      const inputTokens = assistantMessage.usage?.input ?? estimateTokenCount(pendingUserContent);
      const outputTokens = assistantMessage.usage?.output ?? estimateTokenCount(assistantContent);
      const spanStatus =
        assistantMessage.errorMessage || assistantMessage.stopReason === "error" ? "error" : "ok";

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalCostUsd += usageTotals.costUsd;

      if (usageTotals.estimated) {
        isPartial = true;
      }

      if (spanStatus === "error") {
        hasError = true;
      }

      addSpan({
        id: spanId,
        traceId,
        parentSpanId: null,
        externalId: `${sessionFile.sessionId}:assistant:${llmIndex}`,
        type: "llm",
        name: "assistant",
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 0,
        model: model ?? null,
        provider: provider ?? null,
        inputTokens,
        outputTokens,
        costUsd: usageTotals.costUsd,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        toolSuccess: null,
        status: spanStatus,
        errorMessage: assistantMessage.errorMessage ?? null,
        metadata: {
          api: assistantMessage.api ?? null,
          cacheRead: assistantMessage.usage?.cacheRead ?? null,
          cacheWrite: assistantMessage.usage?.cacheWrite ?? null,
          estimatedUsage: usageTotals.estimated,
          stopReason: assistantMessage.stopReason ?? null,
          totalTokens: assistantMessage.usage?.totalTokens ?? null,
        },
      });

      for (const pendingUserEntry of pendingUserEntries) {
        const userContent = flattenContent(pendingUserEntry.message.content);
        messages.push(
          buildMessage(spanId, traceId, "user", userContent, nextPosition(spanId), {
            timestamp: extractEntryTimestamp(pendingUserEntry)?.toISOString() ?? null,
          }),
        );
      }

      pendingUserEntries.length = 0;
      messages.push(
        buildMessage(spanId, traceId, "assistant", assistantContent, nextPosition(spanId), {
          api: assistantMessage.api ?? null,
          stopReason: assistantMessage.stopReason ?? null,
          timestamp: timestamp.toISOString(),
        }),
      );

      for (const toolCall of extractToolCalls(assistantMessage.content)) {
        const toolCallId = toolCall.id ?? `${sessionFile.sessionId}:tool:${++orphanToolIndex}`;
        const toolSpanId = toToolSpanId(traceId, toolCallId);

        toolSpanIdsByCallId.set(toolCallId, toolSpanId);
        addSpan({
          id: toolSpanId,
          traceId,
          parentSpanId: spanId,
          externalId: toolCallId,
          type: "tool",
          name: toolCall.name ?? "tool",
          startedAt: timestamp,
          endedAt: null,
          durationMs: null,
          model: null,
          provider: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          toolName: toolCall.name ?? null,
          toolInput: serializeValue(toolCall.arguments) ?? null,
          toolOutput: null,
          toolSuccess: null,
          status: "ok",
          errorMessage: null,
          metadata: {
            toolCallId,
          },
        });
      }

      lastLlmSpanId = spanId;
      continue;
    }

    if (isToolResultMessage(messageEntry.message)) {
      const toolResult = messageEntry.message;
      const toolCallId = toolResult.toolCallId ?? `orphan:${++orphanToolIndex}`;
      const toolSpanId = toolSpanIdsByCallId.get(toolCallId) ?? toToolSpanId(traceId, toolCallId);
      const existingSpanIndex = spanIndexesById.get(toolSpanId);
      const content = flattenContent(toolResult.content);

      if (existingSpanIndex === undefined) {
        addSpan({
          id: toolSpanId,
          traceId,
          parentSpanId: lastLlmSpanId ?? null,
          externalId: toolCallId,
          type: "tool",
          name: toolResult.toolName ?? "tool",
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          model: null,
          provider: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          toolName: toolResult.toolName ?? null,
          toolInput: null,
          toolOutput: content,
          toolSuccess: !(toolResult.isError ?? false),
          status: toolResult.isError ? "error" : "ok",
          errorMessage: toolResult.isError ? content || "Tool call failed" : null,
          metadata: toolResult.details ?? null,
        });
      } else {
        const existingSpan = spans[existingSpanIndex];
        if (!existingSpan) {
          continue;
        }

        replaceSpan({
          ...existingSpan,
          endedAt: timestamp,
          durationMs: Math.max(0, timestamp.getTime() - existingSpan.startedAt.getTime()),
          toolOutput: content || existingSpan.toolOutput,
          toolSuccess: !(toolResult.isError ?? false),
          status: toolResult.isError ? "error" : existingSpan.status,
          errorMessage: toolResult.isError
            ? content || "Tool call failed"
            : existingSpan.errorMessage,
          metadata: toolResult.details ?? existingSpan.metadata,
        });
      }

      if (toolResult.isError) {
        hasError = true;
      }

      if (content.length === 0) {
        isPartial = true;
      }

      messages.push(
        buildMessage(toolSpanId, traceId, "tool", content, nextPosition(toolSpanId), {
          isError: toolResult.isError ?? false,
          timestamp: timestamp.toISOString(),
          toolName: toolResult.toolName ?? null,
        }),
      );
    }
  }

  if (pendingUserEntries.length > 0) {
    isPartial = true;
  }

  const startedAt =
    parseTimestamp(sessionHeader?.timestamp) ??
    extractEntryTimestamp(readResult.entries[0] ?? { type: "unknown" }) ??
    sessionFile.modifiedAt;
  const traceModel = currentModel ?? sessionHeader?.modelId;

  const trace: TraceRecord = {
    id: traceId,
    externalId: sessionHeader?.id ?? sessionFile.sessionId,
    source: "openclaw",
    sessionKey: sessionHeader?.id ?? sessionFile.sessionId,
    ...(sessionFile.agentId ? { agentId: sessionFile.agentId } : {}),
    startedAt,
    endedAt: lastActivityAt,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    ...(traceModel ? { model: traceModel } : {}),
    status: hasError ? "error" : isPartial ? "partial" : "complete",
    metadata: {
      branchedFrom: sessionHeader?.branchedFrom ?? null,
      compactionCount,
      cwd: sessionHeader?.cwd ?? null,
      provider: currentProvider ?? sessionHeader?.provider ?? null,
      sourceFile: sessionFile.filePath,
      thinkingLevel: sessionHeader?.thinkingLevel ?? null,
    },
    ingestedAt: new Date(),
  };

  return {
    trace,
    spans,
    messages,
    errors,
  };
}
