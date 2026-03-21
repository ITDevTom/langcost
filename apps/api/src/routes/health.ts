import { statSync } from "node:fs";

import {
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
  resolveDbPath,
} from "@langcost/db";
import { Hono } from "hono";

import { withDb } from "../lib/db";

const TRACE_LIMIT_OSS = 500;

function getDbSizeBytes(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

export function createHealthRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const dbPath = resolveDbPath(options.dbPath);
    const payload = await withDb(options.dbPath, (db) => {
      const traceRepository = createTraceRepository(db);
      const spanRepository = createSpanRepository(db);
      const messageRepository = createMessageRepository(db);

      return {
        status: "ok" as const,
        dbPath,
        version: "0.0.1",
        dbSizeBytes: getDbSizeBytes(dbPath),
        lastScanAt: traceRepository.getLastIngestedAt()?.toISOString() ?? null,
        traceCount: traceRepository.count(),
        spanCount: spanRepository.count(),
        messageCount: messageRepository.count(),
        traceLimit: TRACE_LIMIT_OSS,
      };
    });

    return c.json(payload);
  });

  return route;
}
