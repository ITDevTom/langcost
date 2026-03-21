import {
  type AnalyzeOptions,
  type AnalyzeResult,
  calculateCost,
  type IAnalyzer,
  type SegmentType,
  sha256,
} from "@langcost/core";
import type { Db, MessageRecord, SegmentRecord, SpanRecord } from "@langcost/db";
import {
  createMessageRepository,
  createSegmentRepository,
  createSpanRepository,
  createTraceRepository,
} from "@langcost/db";

function toTraceListOptions(options?: AnalyzeOptions) {
  return {
    ...(options?.traceIds ? { traceIds: options.traceIds } : {}),
    ...(options?.since ? { since: options.since } : {}),
  };
}

function isToolSchema(content: string): boolean {
  return /"type"\s*:\s*"function"|"parameters"\s*:/.test(content);
}

function hasRagMarkers(content: string): boolean {
  return /<context>|<documents>|Sources:/i.test(content);
}

function classifyMessage(
  message: MessageRecord,
  userMessages: MessageRecord[],
): { direction: "input" | "output"; type: SegmentType } {
  if (hasRagMarkers(message.content)) {
    return {
      direction: message.role === "assistant" || message.role === "tool" ? "output" : "input",
      type: "rag_context",
    };
  }

  if (message.role === "system") {
    return {
      direction: "input",
      type: isToolSchema(message.content) ? "tool_schema" : "system_prompt",
    };
  }

  if (message.role === "user") {
    const lastUserMessage = userMessages.at(-1);
    return {
      direction: "input",
      type: lastUserMessage?.id === message.id ? "user_query" : "conversation_history",
    };
  }

  if (message.role === "assistant") {
    return { direction: "output", type: "assistant_response" };
  }

  if (message.role === "tool") {
    return { direction: "output", type: "tool_result" };
  }

  return { direction: "input", type: "unknown" };
}

function allocateTokens(totalTokens: number, estimates: number[]): number[] {
  if (estimates.length === 0 || totalTokens <= 0) {
    return estimates.map(() => 0);
  }

  const weightTotal = estimates.reduce((sum, value) => sum + value, 0);
  const normalizedEstimates = weightTotal > 0 ? estimates : estimates.map(() => 1);
  const normalizedTotal = normalizedEstimates.reduce((sum, value) => sum + value, 0);

  const allocations = normalizedEstimates.map((estimate, index) => {
    const raw = (totalTokens * estimate) / normalizedTotal;
    const tokenCount = Math.floor(raw);
    return {
      index,
      tokenCount,
      remainder: raw - tokenCount,
    };
  });

  let remainingTokens = totalTokens - allocations.reduce((sum, entry) => sum + entry.tokenCount, 0);

  allocations.sort((left, right) => {
    if (right.remainder !== left.remainder) {
      return right.remainder - left.remainder;
    }

    return left.index - right.index;
  });

  for (let index = 0; index < allocations.length && remainingTokens > 0; index += 1) {
    const allocation = allocations[index];
    if (!allocation) {
      continue;
    }

    allocation.tokenCount += 1;
    remainingTokens -= 1;
  }

  return allocations
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.tokenCount);
}

async function toContentHash(content: string): Promise<string | null> {
  return content.length > 0 ? await sha256(content) : null;
}

async function buildSegmentsForSpan(
  span: SpanRecord,
  messages: MessageRecord[],
  analyzedAt: Date,
): Promise<SegmentRecord[]> {
  const spanInputTokens = span.inputTokens ?? 0;
  const spanOutputTokens = span.outputTokens ?? 0;
  const spanTotalTokens = spanInputTokens + spanOutputTokens;
  const spanCost =
    span.costUsd ??
    (span.model ? calculateCost(span.model, spanInputTokens, spanOutputTokens).totalCost : 0);

  if (span.type === "tool") {
    const content =
      messages.map((message) => message.content).join("\n") || (span.toolOutput ?? "");
    const tokenCount = messages.reduce((sum, message) => sum + (message.tokenCount ?? 0), 0);

    if (content.length === 0 && tokenCount === 0) {
      return [];
    }

    return [
      {
        id: `segment:${span.id}:output:tool_result`,
        spanId: span.id,
        traceId: span.traceId,
        type: "tool_result",
        tokenCount,
        costUsd: spanCost,
        percentOfSpan: tokenCount > 0 ? 100 : 0,
        contentHash: await toContentHash(content),
        charStart: null,
        charEnd: null,
        analyzedAt,
      },
    ];
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const buckets = new Map<
    string,
    {
      direction: "input" | "output";
      type: SegmentType;
      contentParts: string[];
      estimatedTokens: number;
    }
  >();

  for (const message of messages) {
    const classification = classifyMessage(message, userMessages);
    const key = `${classification.direction}:${classification.type}`;
    const bucket = buckets.get(key) ?? {
      direction: classification.direction,
      type: classification.type,
      contentParts: [],
      estimatedTokens: 0,
    };

    bucket.contentParts.push(message.content);
    bucket.estimatedTokens += message.tokenCount ?? 0;
    buckets.set(key, bucket);
  }

  const hasInputBucket = [...buckets.values()].some((bucket) => bucket.direction === "input");
  const hasOutputBucket = [...buckets.values()].some((bucket) => bucket.direction === "output");

  if (spanInputTokens > 0 && !hasInputBucket) {
    buckets.set("input:unknown", {
      direction: "input",
      type: "unknown",
      contentParts: [],
      estimatedTokens: 0,
    });
  }

  if (spanOutputTokens > 0 && !hasOutputBucket) {
    buckets.set("output:unknown", {
      direction: "output",
      type: "unknown",
      contentParts: [],
      estimatedTokens: 0,
    });
  }

  if (buckets.size === 0) {
    const unknownTokens = spanTotalTokens;
    if (unknownTokens === 0) {
      return [];
    }

    return [
      {
        id: `segment:${span.id}:unknown`,
        spanId: span.id,
        traceId: span.traceId,
        type: "unknown",
        tokenCount: unknownTokens,
        costUsd: spanCost,
        percentOfSpan: 100,
        contentHash: null,
        charStart: null,
        charEnd: null,
        analyzedAt,
      },
    ];
  }

  const bucketEntries = [...buckets.values()];
  const inputBuckets = bucketEntries.filter((bucket) => bucket.direction === "input");
  const outputBuckets = bucketEntries.filter((bucket) => bucket.direction === "output");

  const allocatedInputTokens = allocateTokens(
    spanInputTokens,
    inputBuckets.map((bucket) => bucket.estimatedTokens),
  );
  const allocatedOutputTokens = allocateTokens(
    spanOutputTokens,
    outputBuckets.map((bucket) => bucket.estimatedTokens),
  );

  const inputCostBudget = spanTotalTokens > 0 ? spanCost * (spanInputTokens / spanTotalTokens) : 0;
  const outputCostBudget = spanCost - inputCostBudget;

  const inputTokenTotal = allocatedInputTokens.reduce((sum, value) => sum + value, 0);
  const outputTokenTotal = allocatedOutputTokens.reduce((sum, value) => sum + value, 0);

  const segments: SegmentRecord[] = [];

  for (const [index, bucket] of inputBuckets.entries()) {
    const tokenCount = allocatedInputTokens[index] ?? 0;
    if (tokenCount === 0) {
      continue;
    }

    const content = bucket.contentParts.join("\n");
    segments.push({
      id: `segment:${span.id}:input:${bucket.type}`,
      spanId: span.id,
      traceId: span.traceId,
      type: bucket.type,
      tokenCount,
      costUsd: inputTokenTotal > 0 ? inputCostBudget * (tokenCount / inputTokenTotal) : 0,
      percentOfSpan: spanTotalTokens > 0 ? (tokenCount / spanTotalTokens) * 100 : 0,
      contentHash: await toContentHash(content),
      charStart: null,
      charEnd: null,
      analyzedAt,
    });
  }

  for (const [index, bucket] of outputBuckets.entries()) {
    const tokenCount = allocatedOutputTokens[index] ?? 0;
    if (tokenCount === 0) {
      continue;
    }

    const content = bucket.contentParts.join("\n");
    segments.push({
      id: `segment:${span.id}:output:${bucket.type}`,
      spanId: span.id,
      traceId: span.traceId,
      type: bucket.type,
      tokenCount,
      costUsd: outputTokenTotal > 0 ? outputCostBudget * (tokenCount / outputTokenTotal) : 0,
      percentOfSpan: spanTotalTokens > 0 ? (tokenCount / spanTotalTokens) * 100 : 0,
      contentHash: await toContentHash(content),
      charStart: null,
      charEnd: null,
      analyzedAt,
    });
  }

  return segments;
}

export const costAnalyzer: IAnalyzer<Db> = {
  meta: {
    name: "cost-analyzer",
    version: "0.0.1",
    description: "Aggregates normalized span usage into coarse cost segments.",
    priority: 10,
  },

  async analyze(db: Db, options?: AnalyzeOptions): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const segmentRepository = createSegmentRepository(db);

    const traces = traceRepository.listForAnalysis(toTraceListOptions(options));

    segmentRepository.deleteByTraceIds(traces.map((trace) => trace.id));

    let segmentsWritten = 0;

    for (const [index, trace] of traces.entries()) {
      const spans = spanRepository.listByTraceId(trace.id);

      for (const span of spans) {
        const messages = messageRepository.listBySpanId(span.id);
        const analyzedAt = new Date();
        const segments = await buildSegmentsForSpan(span, messages, analyzedAt);

        for (const segment of segments) {
          segmentRepository.upsert(segment);
        }

        segmentsWritten += segments.length;
      }

      options?.onProgress?.({ current: index + 1, total: traces.length });
    }

    return {
      tracesAnalyzed: traces.length,
      findingsCount: segmentsWritten,
      durationMs: Date.now() - startedAt,
    };
  },
};
