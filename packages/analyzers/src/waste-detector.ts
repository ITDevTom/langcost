import type { AnalyzeOptions, AnalyzeResult, IAnalyzer } from "@langcost/core";
import type { Db } from "@langcost/db";
import {
  createMessageRepository,
  createSegmentRepository,
  createSpanRepository,
  createTraceRepository,
  createWasteReportRepository,
} from "@langcost/db";

import { buildTraceContext, type TraceAnalysisContext } from "./context";
import { tier1Rules } from "./rules";

function toTraceListOptions(options?: AnalyzeOptions) {
  return {
    ...(options?.traceIds ? { traceIds: options.traceIds } : {}),
    ...(options?.since ? { since: options.since } : {}),
  };
}

export const wasteDetector: IAnalyzer<Db> = {
  meta: {
    name: "waste-detector",
    version: "0.0.1",
    description: "Runs Tier 1 waste detection rules against normalized traces.",
    priority: 20,
  },

  async analyze(db: Db, options?: AnalyzeOptions): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const segmentRepository = createSegmentRepository(db);
    const wasteReportRepository = createWasteReportRepository(db);

    const traces = traceRepository.listForAnalysis(toTraceListOptions(options));

    wasteReportRepository.deleteByTraceIds(traces.map((trace) => trace.id));

    const contexts: TraceAnalysisContext[] = [];
    for (const [index, trace] of traces.entries()) {
      const spans = spanRepository.listByTraceId(trace.id);
      const messages = messageRepository.listByTraceId(trace.id);
      const segments = segmentRepository.listByTraceId(trace.id);

      contexts.push(buildTraceContext(trace, spans, messages, segments));
      options?.onProgress?.({ current: index + 1, total: traces.length });
    }

    const reports = tier1Rules.flatMap((rule) => rule.detect(contexts));
    for (const report of reports) {
      wasteReportRepository.upsert(report);
    }

    return {
      tracesAnalyzed: traces.length,
      findingsCount: reports.length,
      durationMs: Date.now() - startedAt,
    };
  },
};
