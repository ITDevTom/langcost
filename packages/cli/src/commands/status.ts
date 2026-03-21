import { existsSync, statSync } from "node:fs";

import {
  createAnalysisRunRepository,
  createDb,
  createIngestionStateRepository,
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
  getSqliteClient,
  migrate,
  resolveDbPath,
} from "@langcost/db";

import { createPalette } from "../output/colors";
import { formatBytes, formatDateTime, formatRelativeTime } from "../output/summary";
import type { CliRuntime, StatusCommandOptions } from "../types";

export async function runStatusCommand(
  options: StatusCommandOptions,
  runtime: CliRuntime,
): Promise<number> {
  const palette = createPalette(runtime.io);
  const dbPath = resolveDbPath(options.dbPath);

  if (!existsSync(dbPath)) {
    runtime.io.write(`Database: ${dbPath} (not found)\n`);
    return 0;
  }

  const db = createDb(dbPath);

  try {
    migrate(db);

    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const ingestionRepository = createIngestionStateRepository(db);
    const analysisRepository = createAnalysisRunRepository(db);
    const stats = statSync(dbPath);
    const lastScan = traceRepository.getLastIngestedAt();
    const adapters = [...new Set(ingestionRepository.list().map((entry) => entry.adapter))];
    const latestAnalysisRun = analysisRepository.listLatest(1)[0];

    const lines = [
      `Database: ${dbPath} (${formatBytes(stats.size)})`,
      `Traces: ${traceRepository.count()} | Spans: ${spanRepository.count()} | Messages: ${messageRepository.count()}`,
      lastScan
        ? `Last scan: ${formatDateTime(lastScan)} (${formatRelativeTime(lastScan, runtime.now())})`
        : "Last scan: never",
      `Adapters used: ${adapters.length > 0 ? adapters.join(", ") : "none"}`,
      latestAnalysisRun
        ? `Last analysis: ${latestAnalysisRun.analyzerName} ${formatRelativeTime(latestAnalysisRun.startedAt, runtime.now())}`
        : `${palette.dim("Last analysis: never")}`,
    ];

    runtime.io.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown status failure";
    runtime.io.error(`${palette.red("Error:")} ${message}\n`);
    return 1;
  } finally {
    getSqliteClient(db).close(false);
  }
}
