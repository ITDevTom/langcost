export interface AdapterMeta {
  name: string;
  version: string;
  description: string;
  sourceType: "local" | "api";
}

export interface IngestOptions {
  sourcePath?: string | undefined;
  file?: string | undefined;
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  adapterOptions?: Record<string, unknown> | undefined;
  since?: Date | undefined;
  force?: boolean | undefined;
  onProgress?: ((event: IngestProgressEvent) => void) | undefined;
}

export interface IngestProgressEvent {
  phase: "discovering" | "reading" | "normalizing" | "writing";
  current: number;
  total?: number;
  sessionId?: string;
}

export interface IngestResult {
  tracesIngested: number;
  spansIngested: number;
  messagesIngested: number;
  skipped: number;
  errors: IngestError[];
  durationMs: number;
}

export interface IngestError {
  file: string;
  line?: number;
  message: string;
}

export interface IAdapter<Db = unknown> {
  readonly meta: AdapterMeta;
  /**
   * Ingest source data into langcost's normalized schema.
   *
   * Wrap each session's writes (trace + spans + messages + ingestion_state)
   * in a single transaction using `getSqliteClient(db).transaction(() => { ... })()`
   * from `@langcost/db`. This keeps the SQLite writer lock held for milliseconds
   * instead of seconds, so concurrent `langcost scan` invocations don't collide.
   * See `packages/adapter-warp/src/adapter.ts` for the canonical pattern.
   *
   * Should be idempotent — consult `ingestion_state` to skip already-ingested sessions.
   */
  ingest(db: Db, options?: IngestOptions): Promise<IngestResult>;
  validate(options?: IngestOptions): Promise<{ ok: boolean; message: string }>;
}
