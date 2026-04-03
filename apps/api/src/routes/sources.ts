import { createTraceRepository } from "@langcost/db";
import { Hono } from "hono";

import { withDb } from "../lib/db";

export function createSourcesRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const payload = await withDb(options.dbPath, (db) => {
      const traceRepository = createTraceRepository(db);
      const traces = traceRepository.listForAnalysis();

      const sourceMap = new Map<string, { count: number; lastScanAt: Date }>();

      for (const trace of traces) {
        const existing = sourceMap.get(trace.source);
        if (!existing) {
          sourceMap.set(trace.source, { count: 1, lastScanAt: trace.ingestedAt });
        } else {
          existing.count += 1;
          if (trace.ingestedAt.getTime() > existing.lastScanAt.getTime()) {
            existing.lastScanAt = trace.ingestedAt;
          }
        }
      }

      return {
        sources: [...sourceMap.entries()].map(([name, data]) => ({
          name,
          traceCount: data.count,
          lastScanAt: data.lastScanAt.toISOString(),
        })),
      };
    });

    return c.json(payload);
  });

  return route;
}
