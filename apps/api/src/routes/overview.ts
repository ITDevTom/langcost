import {
  createSpanRepository,
  createTraceRepository,
  createWasteReportRepository,
} from "@langcost/db";
import { Hono } from "hono";

import { buildOverviewPayload } from "../lib/aggregations";
import { withDb } from "../lib/db";

export function createOverviewRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const source = c.req.query("source");

    const payload = await withDb(options.dbPath, (db) => {
      let traces = createTraceRepository(db).listForAnalysis();
      let wasteReports = createWasteReportRepository(db).list();
      const spanRepository = createSpanRepository(db);

      if (source) {
        const traceIds = new Set(traces.filter((t) => t.source === source).map((t) => t.id));
        traces = traces.filter((t) => t.source === source);
        wasteReports = wasteReports.filter((r) => traceIds.has(r.traceId));
      }

      // Build turn counts per trace (LLM spans = turns)
      const turnsByTraceId = new Map<string, number>();
      for (const trace of traces) {
        const spans = spanRepository.listByTraceId(trace.id);
        turnsByTraceId.set(trace.id, spans.filter((s) => s.type === "llm").length);
      }

      return buildOverviewPayload(traces, wasteReports, turnsByTraceId);
    });

    return c.json(payload);
  });

  return route;
}
