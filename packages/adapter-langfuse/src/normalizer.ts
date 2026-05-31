import { calculateCost } from "@langcost/core";
import type { MessageRecord, SpanRecord, TraceRecord } from "@langcost/db";

import type { LangfuseObservation, LangfuseTrace } from "./types";

export interface NormalizedLangfuseTrace {
  trace: TraceRecord;
  spans: SpanRecord[];
  messages: MessageRecord[];
}

const SOURCE = "langfuse";
const nsId = (langfuseId: string): string => `langfuse:${langfuseId}`;

/**
 * Map a Langfuse observation type to our 4 span types. generation/embedding → llm, tool → tool,
 * retriever → retrieval, agent → agent. Everything else (SPAN/EVENT/chain/evaluator/guardrail) maps
 * to the generic `agent` bucket, with the original type preserved in `metadata.langfuseType`.
 * (Open question in langfuse_implementation.md: extend the span.type enum instead of bucketing.)
 */
function mapType(raw: string): SpanRecord["type"] {
  const t = raw.toLowerCase();
  if (t === "generation" || t === "embedding") return "llm";
  if (t === "tool") return "tool";
  if (t === "retriever") return "retrieval";
  if (t === "agent") return "agent";
  return "agent";
}

function normalizeRole(role: unknown): MessageRecord["role"] {
  const r = String(role ?? "").toLowerCase();
  if (r === "system" || r === "user" || r === "assistant" || r === "tool") return r;
  if (r === "human") return "user";
  if (r === "ai" || r === "model" || r === "bot") return "assistant";
  return "user";
}

/** Langfuse input/output are arbitrary JSON — stringify non-strings so they're storable as content. */
function asText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const MAX_CONTENT = 200_000;

/** Parse an llm observation's chat-shaped input/output into ordered messages (shape-detected). */
function parseMessages(obs: LangfuseObservation, traceId: string): MessageRecord[] {
  const spanId = nsId(obs.id);
  const messages: MessageRecord[] = [];
  let position = 0;
  const push = (role: MessageRecord["role"], content: string | undefined): void => {
    if (!content) return;
    messages.push({
      id: `${spanId}:m${position}`,
      spanId,
      traceId,
      role,
      content: content.slice(0, MAX_CONTENT),
      position,
    });
    position += 1;
  };

  const pushChatItem = (item: unknown): void => {
    if (item && typeof item === "object" && "role" in item) {
      const record = item as { role?: unknown; content?: unknown };
      push(normalizeRole(record.role), asText(record.content) ?? asText(item));
    } else {
      push("user", asText(item));
    }
  };

  const input = obs.input;
  if (Array.isArray(input)) {
    for (const item of input) pushChatItem(item);
  } else if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as { messages?: unknown }).messages)
  ) {
    for (const item of (input as { messages: unknown[] }).messages) pushChatItem(item);
  } else if (input != null) {
    push("user", asText(input));
  }

  const output = obs.output;
  if (output != null) {
    const content =
      output && typeof output === "object" && "content" in output
        ? asText((output as { content?: unknown }).content)
        : asText(output);
    push("assistant", content);
  }

  return messages;
}

export function normalizeLangfuseTrace(
  langfuseTrace: LangfuseTrace,
  observations: LangfuseObservation[],
): NormalizedLangfuseTrace {
  const traceId = nsId(langfuseTrace.id);
  const spans: SpanRecord[] = [];
  const messages: MessageRecord[] = [];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let anyError = false;
  let endMs = new Date(langfuseTrace.timestamp).getTime();
  const modelCounts = new Map<string, number>();

  for (const obs of observations) {
    const type = mapType(obs.type);
    const startedAt = new Date(obs.startTime);
    const endedAt = obs.endTime ? new Date(obs.endTime) : null;
    if (endedAt) endMs = Math.max(endMs, endedAt.getTime());

    const inputTokens = typeof obs.usageDetails?.input === "number" ? obs.usageDetails.input : null;
    const outputTokens =
      typeof obs.usageDetails?.output === "number" ? obs.usageDetails.output : null;
    const isError = String(obs.level ?? "").toUpperCase() === "ERROR";
    if (isError) anyError = true;

    // Prefer Langfuse-provided cost; otherwise compute via core pricing (null when model unpriced).
    let costUsd: number | null =
      typeof obs.costDetails?.total === "number" ? obs.costDetails.total : null;
    if (costUsd === null && obs.model && (inputTokens !== null || outputTokens !== null)) {
      costUsd = calculateCost(obs.model, inputTokens ?? 0, outputTokens ?? 0)?.totalCost ?? null;
    }

    if (type === "llm") {
      totalInputTokens += inputTokens ?? 0;
      totalOutputTokens += outputTokens ?? 0;
      totalCostUsd += costUsd ?? 0;
      if (obs.model) modelCounts.set(obs.model, (modelCounts.get(obs.model) ?? 0) + 1);
    }

    const metadata: Record<string, unknown> = { langfuseType: obs.type };
    if (obs.metadata && typeof obs.metadata === "object") Object.assign(metadata, obs.metadata);
    const cacheRead = obs.usageDetails?.cache_read_input_tokens;
    const cacheCreation = obs.usageDetails?.cache_creation_input_tokens;
    if (typeof cacheRead === "number") metadata.cacheRead = cacheRead;
    if (typeof cacheCreation === "number") metadata.cacheCreationTokens = cacheCreation;

    spans.push({
      id: nsId(obs.id),
      traceId,
      parentSpanId: obs.parentObservationId ? nsId(obs.parentObservationId) : null,
      externalId: obs.id,
      type,
      name: obs.name ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
      model: obs.model ?? null,
      provider: null,
      inputTokens,
      outputTokens,
      costUsd,
      toolName: type === "tool" ? (obs.name ?? null) : null,
      toolInput: type === "tool" ? (asText(obs.input) ?? null) : null,
      toolOutput: type === "tool" ? (asText(obs.output) ?? null) : null,
      toolSuccess: type === "tool" ? !isError : null,
      status: isError ? "error" : "ok",
      errorMessage: isError ? (obs.statusMessage ?? null) : null,
      metadata,
    });

    if (type === "llm") messages.push(...parseMessages(obs, traceId));
  }

  const dominantModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const traceMetadata: Record<string, unknown> = {};
  if (langfuseTrace.name) traceMetadata.name = langfuseTrace.name;
  if (langfuseTrace.userId) traceMetadata.userId = langfuseTrace.userId;
  if (langfuseTrace.tags?.length) traceMetadata.tags = langfuseTrace.tags;
  if (langfuseTrace.release) traceMetadata.release = langfuseTrace.release;
  if (langfuseTrace.version) traceMetadata.version = langfuseTrace.version;
  if (langfuseTrace.environment) traceMetadata.environment = langfuseTrace.environment;
  if (langfuseTrace.metadata && typeof langfuseTrace.metadata === "object") {
    Object.assign(traceMetadata, langfuseTrace.metadata);
  }

  const trace: TraceRecord = {
    id: traceId,
    externalId: langfuseTrace.id,
    source: SOURCE,
    startedAt: new Date(langfuseTrace.timestamp),
    endedAt: new Date(endMs),
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    status: anyError ? "error" : "complete",
    metadata: traceMetadata,
    ingestedAt: new Date(),
    ...(langfuseTrace.sessionId ? { sessionKey: langfuseTrace.sessionId } : {}),
    ...(dominantModel ? { model: dominantModel } : {}),
  };

  return { trace, spans, messages };
}
