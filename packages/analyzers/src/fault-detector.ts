import type { AnalyzeOptions, AnalyzeResult, IAnalyzer } from "@langcost/core";
import type { Db } from "@langcost/db";
import {
  createFaultReportRepository,
  createMessageRepository,
  createSegmentRepository,
  createSettingsRepository,
  createSpanRepository,
  createTraceRepository,
} from "@langcost/db";

import { buildTraceContext, type TraceAnalysisContext } from "./context";
import { resolveFaultRules } from "./rules/fault/registry";
import { satisfiesRequirements } from "./rules/requirements";

function toTraceListOptions(options?: AnalyzeOptions) {
  return {
    ...(options?.traceIds ? { traceIds: options.traceIds } : {}),
    ...(options?.since ? { since: options.since } : {}),
  };
}

export const faultDetector: IAnalyzer<Db> = {
  meta: {
    name: "fault-detector",
    version: "0.0.1",
    description: "Runs the user-enabled fault-attribution rules against normalized traces.",
    priority: 30,
  },

  async analyze(db: Db, options?: AnalyzeOptions): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const segmentRepository = createSegmentRepository(db);
    const faultReportRepository = createFaultReportRepository(db);

    const traces = traceRepository.listForAnalysis(toTraceListOptions(options));

    faultReportRepository.deleteByTraceIds(traces.map((trace) => trace.id));

    const contexts: TraceAnalysisContext[] = [];
    for (const [index, trace] of traces.entries()) {
      const spans = spanRepository.listByTraceId(trace.id);
      const messages = messageRepository.listByTraceId(trace.id);
      const segments = segmentRepository.listByTraceId(trace.id);

      contexts.push(buildTraceContext(trace, spans, messages, segments));
      options?.onProgress?.({ current: index + 1, total: traces.length });
    }

    // Strict opt-in: only fault rules enabled in `rules_config` run (absent config -> none).
    const rulesConfig = createSettingsRepository(db).getRulesConfig();
    const activeRules = resolveFaultRules(rulesConfig);

    const reports = activeRules.flatMap(({ rule, resolved, sources }) => {
      const scoped =
        sources === "*"
          ? contexts
          : contexts.filter((context) => sources.includes(context.trace.source));
      const eligible = scoped.filter((context) => satisfiesRequirements(context, rule.requires));
      return rule.detect(eligible, resolved);
    });
    for (const report of reports) {
      faultReportRepository.upsert(report);
    }

    return {
      tracesAnalyzed: traces.length,
      findingsCount: reports.length,
      durationMs: Date.now() - startedAt,
    };
  },
};
