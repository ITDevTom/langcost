import { createSegmentRepository, createTraceRepository } from "@langcost/db";
import { Hono } from "hono";

import { groupBy, sumBy } from "../lib/aggregations";
import { withDb } from "../lib/db";

export function createSegmentsRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/breakdown", async (c) => {
    const since = c.req.query("since");
    const model = c.req.query("model");

    const payload = await withDb(options.dbPath, (db) => {
      const traceRepository = createTraceRepository(db);
      const segmentRepository = createSegmentRepository(db);

      let traces = traceRepository.listForAnalysis({
        ...(since ? { since: new Date(since) } : {}),
      });

      if (model) {
        traces = traces.filter((trace) => trace.model === model);
      }

      const segments = traces.flatMap((trace) => segmentRepository.listByTraceId(trace.id));
      const totalTokens = sumBy(segments, (segment) => segment.tokenCount);
      const totalCostUsd = sumBy(segments, (segment) => segment.costUsd);

      const byType = [...groupBy(segments, (segment) => segment.type).entries()].map(
        ([type, items]) => {
          const costUsd = sumBy(items, (item) => item.costUsd);
          return {
            type,
            totalTokens: sumBy(items, (item) => item.tokenCount),
            totalCostUsd: costUsd,
            percentage: totalCostUsd > 0 ? (costUsd / totalCostUsd) * 100 : 0,
          };
        },
      );

      return {
        byType,
        totalTokens,
        totalCostUsd,
      };
    });

    return c.json(payload);
  });

  return route;
}
