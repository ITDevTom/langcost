// Langfuse public-API shapes (the subset the adapter reads). Field names verified against
// platform.claude... no — against langfuse.com/docs (see langfuse_implementation.md §1). input/output
// and metadata are arbitrary JSON, so they're typed `unknown` and shape-detected in the normalizer.

export interface LangfuseUsageDetails {
  input?: number;
  output?: number;
  total?: number;
  // Anthropic cache buckets + any other usage types (audio_tokens, reasoning, …)
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: number | undefined;
}

export interface LangfuseCostDetails {
  input?: number;
  output?: number;
  total?: number;
  [key: string]: number | undefined;
}

/** Underlying type is SPAN|GENERATION|EVENT; newer rich types add agent/tool/retriever/etc. */
export type LangfuseObservationType = string;

export interface LangfuseObservation {
  id: string;
  traceId: string;
  parentObservationId?: string | null;
  type: LangfuseObservationType;
  name?: string | null;
  startTime: string;
  endTime?: string | null;
  level?: string | null; // DEBUG | DEFAULT | WARNING | ERROR
  statusMessage?: string | null;
  model?: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  usageDetails?: LangfuseUsageDetails | null;
  costDetails?: LangfuseCostDetails | null;
}

export interface LangfuseTrace {
  id: string;
  name?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  tags?: string[] | null;
  environment?: string | null;
  release?: string | null;
  version?: string | null;
}

export interface LangfuseObservationsPage {
  data: LangfuseObservation[];
  meta?: { cursor?: string | null } | null;
}
