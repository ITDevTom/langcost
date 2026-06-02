import type { IAdapter, IngestOptions, IngestResult } from "@langcost/core";
import {
  createIngestionStateRepository,
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
  type Db,
  getSqliteClient,
} from "@langcost/db";

import { normalizeLangfuseTrace } from "./normalizer";
import type {
  LangfuseObservation,
  LangfuseObservationsPage,
  LangfuseTrace,
  LangfuseTracesPage,
} from "./types";

const DEFAULT_BASE = "https://cloud.langfuse.com";
// v2 observations omit input/output by default — must request `io` or message bodies come back empty
// and every message-dependent rule goes dark (langfuse_implementation.md §6.8).
const FIELDS = "core,basic,io,usage,costDetails,model,metadata";
// Langfuse Cloud rate-limits the "all other APIs" bucket to as little as 30 req/min PER ORG on the
// free plan (langfuse.com/faq/all/api-limits → 429 + Retry-After). So we keep request count low:
// page in bulk (PAGE_SIZE per call), default to a short window, and back off on 429/5xx.
const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Default lower bound when neither a watermark nor an explicit `since` is given — bounds the first
// pull so a large project can't time out or exhaust the rate limit on initial sync.
const DEFAULT_WINDOW_DAYS = 30;
const MAX_RETRIES = 5;
// Hard page ceiling so a pathological cursor/page response can't loop forever; the window keeps
// real runs far below this.
const MAX_PAGES = 1000;

function resolveBaseUrl(options?: IngestOptions): string {
  return options?.apiUrl?.replace(/\/+$/, "") || DEFAULT_BASE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Langfuse uses HTTP Basic auth with TWO keys. SourceSettings carries a single `apiKey`, so the
// convention is apiKey = "publicKey:secretKey" (langfuse_implementation.md §6.7 open question).
function authHeader(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  const sep = apiKey.indexOf(":");
  if (sep <= 0) return null;
  const publicKey = apiKey.slice(0, sep);
  const secretKey = apiKey.slice(sep + 1);
  if (!publicKey || !secretKey) return null;
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`;
}

// Retry on 429 (rate limit) and 5xx (transient), honoring Retry-After; everything else throws.
async function getJson<T>(url: string, auth: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (response.ok) {
      return (await response.json()) as T;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Langfuse API ${response.status} ${response.statusText} for ${url}`);
    }

    // Prefer the server's Retry-After (seconds); otherwise exponential backoff capped at 30s.
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 1000);
    await sleep(waitMs);
  }
}

export const langfuseAdapter: IAdapter<Db> = {
  meta: {
    name: "langfuse",
    version: "0.1.0",
    description: "Ingest production agent traces from the Langfuse API into langcost SQLite.",
    sourceType: "api",
    product: "ai",
  },

  async validate(options?: IngestOptions) {
    const auth = authHeader(options?.apiKey);
    if (!auth) {
      return {
        ok: false,
        message: 'Langfuse needs a public + secret key. Pass apiKey as "publicKey:secretKey".',
      };
    }
    try {
      await getJson(`${resolveBaseUrl(options)}/api/public/projects`, auth);
      return { ok: true, message: `Connected to Langfuse at ${resolveBaseUrl(options)}.` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Langfuse auth check failed.",
      };
    }
  },

  async ingest(db: Db, options?: IngestOptions): Promise<IngestResult> {
    const startedAt = Date.now();
    const auth = authHeader(options?.apiKey);
    if (!auth) {
      throw new Error(
        'Langfuse needs a public + secret key. Pass apiKey as "publicKey:secretKey".',
      );
    }

    const base = resolveBaseUrl(options);
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const ingestionRepository = createIngestionStateRepository(db);
    const sqlite = getSqliteClient(db);
    const stateKey = `langfuse:${base}`;
    const errors: IngestResult["errors"] = [];

    // Incremental watermark (ISO startTime). --force re-pulls everything.
    const existing = options?.force ? null : ingestionRepository.getBySourcePath(stateKey);
    // Lower bound for this pull: watermark > explicit --since > default short window.
    const fromTime =
      existing?.lastSessionId ??
      options?.since?.toISOString() ??
      new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
    let newestStartTime = fromTime;

    // 1) Page the v2 observations API (cursor-based); group by trace.
    const observationsByTrace = new Map<string, LangfuseObservation[]>();
    let cursor: string | undefined;
    let obsPages = 0;
    do {
      const params = new URLSearchParams({
        fields: FIELDS,
        limit: String(PAGE_SIZE),
        fromStartTime: fromTime,
      });
      if (cursor) params.set("cursor", cursor);

      const page = await getJson<LangfuseObservationsPage>(
        `${base}/api/public/v2/observations?${params.toString()}`,
        auth,
      );

      for (const obs of page.data ?? []) {
        const list = observationsByTrace.get(obs.traceId);
        if (list) {
          list.push(obs);
        } else {
          observationsByTrace.set(obs.traceId, [obs]);
        }
        if (!newestStartTime || obs.startTime > newestStartTime) newestStartTime = obs.startTime;
      }

      cursor = page.meta?.cursor ?? undefined;
      obsPages += 1;
      options?.onProgress?.({ phase: "reading", current: observationsByTrace.size });
    } while (cursor && obsPages < MAX_PAGES);

    // 2) Page the traces LIST (page-based) for bulk metadata. This replaces a per-trace
    //    GET /traces/{id} (an N+1 that would exhaust the 30 req/min free-tier limit) with one
    //    request per ~PAGE_SIZE traces.
    const tracesById = new Map<string, LangfuseTrace>();
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        page: String(pageNum),
        fromTimestamp: fromTime,
      });
      const page = await getJson<LangfuseTracesPage>(
        `${base}/api/public/traces?${params.toString()}`,
        auth,
      );
      const data = page.data ?? [];
      for (const t of data) tracesById.set(t.id, t);

      const totalPages = page.meta?.totalPages ?? pageNum;
      if (data.length === 0 || pageNum >= totalPages) break;
    }

    // 3) Per trace: use bulk metadata (falling back to a minimal trace from the observations),
    //    normalize, and write in a per-trace transaction.
    let tracesIngested = 0;
    let spansIngested = 0;
    let messagesIngested = 0;

    for (const [langfuseTraceId, observations] of observationsByTrace) {
      try {
        const langfuseTrace: LangfuseTrace = tracesById.get(langfuseTraceId) ?? {
          id: langfuseTraceId,
          timestamp: observations.reduce(
            (min, obs) => (obs.startTime < min ? obs.startTime : min),
            observations[0]?.startTime ?? new Date().toISOString(),
          ),
        };

        const normalized = normalizeLangfuseTrace(langfuseTrace, observations);

        options?.onProgress?.({
          phase: "writing",
          current: tracesIngested + 1,
          total: observationsByTrace.size,
          sessionId: langfuseTraceId,
        });

        sqlite.transaction(() => {
          traceRepository.upsert(normalized.trace);
          for (const span of normalized.spans) spanRepository.upsert(span);
          for (const message of normalized.messages) messageRepository.upsert(message);
        })();

        tracesIngested += 1;
        spansIngested += normalized.spans.length;
        messagesIngested += normalized.messages.length;
      } catch (cause) {
        errors.push({
          file: langfuseTraceId,
          message: cause instanceof Error ? cause.message : "Unknown Langfuse trace failure",
        });
      }
    }

    // 4) Advance the watermark.
    if (newestStartTime) {
      ingestionRepository.upsert({
        sourcePath: stateKey,
        adapter: "langfuse",
        lastOffset: 0,
        lastLineHash: null,
        lastSessionId: newestStartTime,
        updatedAt: new Date(),
      });
    }

    return {
      tracesIngested,
      spansIngested,
      messagesIngested,
      skipped: 0,
      errors,
      durationMs: Date.now() - startedAt,
    };
  },
};
