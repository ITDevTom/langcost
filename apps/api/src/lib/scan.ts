import { runPipeline } from "@langcost/analyzers";
import {
  createSettingsRepository,
  createTraceRepository,
  type Db,
  type SourceSettings,
} from "@langcost/db";

import { loadAdapter } from "./adapter-loader";
import { withDb } from "./db";

export interface ScanResultPayload {
  tracesIngested: number;
  spansIngested: number;
  messagesIngested: number;
  skipped: number;
  durationMs: number;
}

function toAdapterOptions(sourceConfig: SourceSettings & { source: string }, force = false) {
  return {
    ...(sourceConfig.sourcePath ? { sourcePath: sourceConfig.sourcePath } : {}),
    force,
    ...(sourceConfig.apiKey ? { apiKey: sourceConfig.apiKey } : {}),
    ...(sourceConfig.apiUrl ? { apiUrl: sourceConfig.apiUrl } : {}),
  };
}

function requireSourceConfig(settings: SourceSettings | null): SourceSettings & { source: string } {
  if (!settings?.source) {
    throw new Error("No source configured. Save settings before triggering a scan.");
  }

  return {
    source: settings.source,
    ...(settings.sourcePath ? { sourcePath: settings.sourcePath } : {}),
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.apiUrl ? { apiUrl: settings.apiUrl } : {}),
  };
}

function pruneToTraceLimit(db: Db, limit: number): void {
  const traceRepository = createTraceRepository(db);
  const traces = traceRepository.listForAnalysis();

  if (traces.length <= limit) {
    return;
  }

  const idsToDelete = traces.slice(limit).map((trace) => trace.id);
  traceRepository.deleteByIds(idsToDelete);
}

export async function runConfiguredScan(
  dbPath?: string,
  force = false,
): Promise<ScanResultPayload> {
  return withDb(dbPath, async (db) => {
    const settingsRepository = createSettingsRepository(db);
    const sourceConfig = requireSourceConfig(settingsRepository.getSourceConfig());
    const adapter = await loadAdapter(sourceConfig.source);

    const validation = await adapter.validate(toAdapterOptions(sourceConfig));

    if (!validation.ok) {
      throw new Error(validation.message);
    }

    const startedAt = new Date();
    const ingestResult = await adapter.ingest(db, toAdapterOptions(sourceConfig, force));

    const traceRepository = createTraceRepository(db);
    const traceIds = traceRepository
      .listForAnalysis()
      .filter((trace) => trace.ingestedAt.getTime() >= startedAt.getTime())
      .map((trace) => trace.id);

    if (traceIds.length > 0) {
      await runPipeline(db, undefined, { traceIds, force });
    }

    pruneToTraceLimit(db, 500);

    return {
      tracesIngested: ingestResult.tracesIngested,
      spansIngested: ingestResult.spansIngested,
      messagesIngested: ingestResult.messagesIngested,
      skipped: ingestResult.skipped,
      durationMs: ingestResult.durationMs,
    };
  });
}
