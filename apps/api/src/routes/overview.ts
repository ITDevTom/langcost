import { createTraceRepository, createWasteReportRepository } from "@langcost/db";
import { Hono } from "hono";

import { buildOverviewPayload } from "../lib/aggregations";
import { withDb } from "../lib/db";

export function createOverviewRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const payload = await withDb(options.dbPath, (db) => {
      const traces = createTraceRepository(db).listForAnalysis();
      const wasteReports = createWasteReportRepository(db).list();
      return buildOverviewPayload(traces, wasteReports);
    });

    return c.json(payload);
  });

  return route;
}
