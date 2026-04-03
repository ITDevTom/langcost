import {
  createMessageRepository,
  createSegmentRepository,
  createSpanRepository,
  createTraceRepository,
  createWasteReportRepository,
} from "@langcost/db";
import { Hono } from "hono";

import { normalizeTraceDetail, serializeTraceSummary, sortTraces } from "../lib/aggregations";
import { withDb } from "../lib/db";

export function createTracesRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    const offset = Number(c.req.query("offset") ?? "0");
    const sort = c.req.query("sort") ?? "date_desc";
    const since = c.req.query("since");
    const model = c.req.query("model");
    const status = c.req.query("status");
    const source = c.req.query("source");

    const payload = await withDb(options.dbPath, (db) => {
      const traceRepository = createTraceRepository(db);
      const spanRepository = createSpanRepository(db);
      const wasteRepository = createWasteReportRepository(db);
      const wasteReports = wasteRepository.list();

      let traces = traceRepository.listForAnalysis({
        ...(since ? { since: new Date(since) } : {}),
      });

      if (source) {
        traces = traces.filter((trace) => trace.source === source);
      }

      if (model) {
        traces = traces.filter((trace) => trace.model === model);
      }

      if (status) {
        traces = traces.filter((trace) => trace.status === status);
      }

      const summaries = traces.map((trace) =>
        serializeTraceSummary(
          trace,
          wasteReports.filter((report) => report.traceId === trace.id),
          spanRepository.listByTraceId(trace.id).length,
        ),
      );

      const sorted = sortTraces(summaries, sort);
      return {
        traces: sorted.slice(offset, offset + limit),
        total: sorted.length,
      };
    });

    return c.json(payload);
  });

  route.get("/:traceId", async (c) => {
    const traceId = c.req.param("traceId");

    const payload = await withDb(options.dbPath, (db) => {
      const traceRepository = createTraceRepository(db);
      const spanRepository = createSpanRepository(db);
      const segmentRepository = createSegmentRepository(db);
      const wasteRepository = createWasteReportRepository(db);
      const messageRepository = createMessageRepository(db);

      const trace = traceRepository.getById(traceId);
      if (!trace) {
        return null;
      }

      const spans = spanRepository.listByTraceId(traceId);
      const segments = segmentRepository.listByTraceId(traceId);
      const wasteReports = wasteRepository.listByTraceId(traceId);
      const messages = messageRepository.listByTraceId(traceId);

      return {
        ...normalizeTraceDetail(trace, spans, segments, wasteReports),
        messages,
      };
    });

    if (!payload) {
      return c.json({ error: "trace not found" }, 404);
    }

    return c.json(payload);
  });

  return route;
}
