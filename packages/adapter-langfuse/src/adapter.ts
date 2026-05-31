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
import type { LangfuseObservation, LangfuseObservationsPage, LangfuseTrace } from "./types";

const DEFAULT_BASE = "https://cloud.langfuse.com";
// v2 observations omit input/output by default — must request `io` or message bodies come back empty
// and every message-dependent rule goes dark (langfuse_implementation.md §6.8).
const FIELDS = "core,basic,io,usage,costDetails,model,metadata";

function resolveBaseUrl(options?: IngestOptions): string {
  return options?.apiUrl?.replace(/\/+$/, "") || DEFAULT_BASE;
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

async function getJson<T>(url: string, auth: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Langfuse API ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
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
    const fromStartTime = existing?.lastSessionId ?? options?.since?.toISOString();
    let newestStartTime = fromStartTime;

    // 1) Page through the v2 observations API; group by trace.
    const observationsByTrace = new Map<string, LangfuseObservation[]>();
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ fields: FIELDS, limit: "50" });
      if (fromStartTime) params.set("fromStartTime", fromStartTime);
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
      options?.onProgress?.({ phase: "reading", current: observationsByTrace.size });
    } while (cursor);

    // 2) Per trace: fetch trace metadata, normalize, write in a per-trace transaction.
    let tracesIngested = 0;
    let spansIngested = 0;
    let messagesIngested = 0;

    for (const [langfuseTraceId, observations] of observationsByTrace) {
      try {
        let langfuseTrace: LangfuseTrace;
        try {
          langfuseTrace = await getJson<LangfuseTrace>(
            `${base}/api/public/traces/${encodeURIComponent(langfuseTraceId)}`,
            auth,
          );
        } catch {
          // Fall back to a minimal trace derived from the observations.
          const earliest = observations.reduce(
            (min, obs) => (obs.startTime < min ? obs.startTime : min),
            observations[0]?.startTime ?? new Date().toISOString(),
          );
          langfuseTrace = { id: langfuseTraceId, timestamp: earliest };
        }

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

    // 3) Advance the watermark.
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
