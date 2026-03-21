import type {
  MessageRecord,
  SegmentRecord,
  SpanRecord,
  TraceRecord,
  WasteReportRecord,
} from "@langcost/db";

const INFORMATIONAL_WASTE_CATEGORIES = new Set(["model_overuse"]);

export function toDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function sumBy<T>(items: T[], project: (item: T) => number): number {
  return items.reduce((sum, item) => sum + project(item), 0);
}

export function groupBy<T, K extends string>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

export function isActionableWasteReport(report: WasteReportRecord): boolean {
  return !INFORMATIONAL_WASTE_CATEGORIES.has(report.category);
}

export function getActionableWasteReports(reports: WasteReportRecord[]): WasteReportRecord[] {
  return reports.filter(isActionableWasteReport);
}

export function buildCostBreakdown(
  trace: TraceRecord,
  segments: SegmentRecord[],
  wasteReports: WasteReportRecord[],
) {
  const actionableWasteReports = getActionableWasteReports(wasteReports);
  const totalSegmentCost = sumBy(segments, (segment) => segment.costUsd);
  const totalWasteUsd = sumBy(actionableWasteReports, (report) => report.wastedCostUsd);
  const totalsByType = groupBy(segments, (segment) => segment.type);

  return {
    traceId: trace.id,
    totalCostUsd: totalSegmentCost,
    totalInputTokens: trace.totalInputTokens,
    totalOutputTokens: trace.totalOutputTokens,
    segments: [...totalsByType.entries()].map(([type, items]) => {
      const costUsd = sumBy(items, (item) => item.costUsd);
      return {
        type,
        tokenCount: sumBy(items, (item) => item.tokenCount),
        costUsd,
        percentOfTotal: totalSegmentCost > 0 ? (costUsd / totalSegmentCost) * 100 : 0,
      };
    }),
    wastePercentage:
      trace.totalCostUsd > 0
        ? (Math.min(totalWasteUsd, trace.totalCostUsd) / trace.totalCostUsd) * 100
        : 0,
    wastedCostUsd: Math.min(totalWasteUsd, trace.totalCostUsd),
  };
}

export function getTopSpans(spans: SpanRecord[], limit: number): SpanRecord[] {
  return [...spans]
    .sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0))
    .slice(0, limit);
}

export function buildOverviewPayload(traces: TraceRecord[], wasteReports: WasteReportRecord[]) {
  const actionableWasteReports = getActionableWasteReports(wasteReports);
  const totalCostUsd = sumBy(traces, (trace) => trace.totalCostUsd);
  const tracesWithWaste = new Set(actionableWasteReports.map((report) => report.traceId)).size;

  // Cap waste per trace at actual trace cost to avoid waste > cost from overlapping rules
  const traceCostById = new Map(traces.map((trace) => [trace.id, trace.totalCostUsd]));
  const rawWasteByTraceId = new Map<string, number>();
  for (const report of actionableWasteReports) {
    rawWasteByTraceId.set(
      report.traceId,
      (rawWasteByTraceId.get(report.traceId) ?? 0) + report.wastedCostUsd,
    );
  }
  const wasteByTraceId = new Map<string, number>();
  for (const [traceId, rawWaste] of rawWasteByTraceId) {
    const traceCost = traceCostById.get(traceId) ?? 0;
    wasteByTraceId.set(traceId, Math.min(rawWaste, traceCost));
  }
  const totalWastedUsd = sumBy([...wasteByTraceId.values()], (v) => v);

  const topWasteCategories = [
    ...groupBy(actionableWasteReports, (report) => report.category).entries(),
  ]
    .map(([category, reports]) => ({
      category,
      count: reports.length,
      totalWasted: sumBy(reports, (report) => report.wastedCostUsd),
    }))
    .sort((left, right) => right.totalWasted - left.totalWasted)
    .slice(0, 5);

  const costByDay = [...groupBy(traces, (trace) => toDateKey(trace.startedAt)).entries()]
    .map(([date, dayTraces]) => ({
      date,
      costUsd: sumBy(dayTraces, (trace) => trace.totalCostUsd),
      wastedUsd: sumBy(dayTraces, (trace) => wasteByTraceId.get(trace.id) ?? 0),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const costByModel = [...groupBy(traces, (trace) => trace.model ?? "unknown").entries()]
    .map(([model, items]) => ({
      model,
      costUsd: sumBy(items, (item) => item.totalCostUsd),
      traceCount: items.length,
    }))
    .sort((left, right) => right.costUsd - left.costUsd);

  return {
    totalTraces: traces.length,
    totalCostUsd,
    totalWastedUsd,
    wastePercentage: totalCostUsd > 0 ? (totalWastedUsd / totalCostUsd) * 100 : 0,
    tracesWithWaste,
    topWasteCategories,
    costByDay,
    costByModel,
    lastScanAt:
      traces.length > 0
        ? new Date(Math.max(...traces.map((trace) => trace.ingestedAt.getTime()))).toISOString()
        : null,
  };
}

export function buildRecommendations(wasteReports: WasteReportRecord[]) {
  const actionableWasteReports = getActionableWasteReports(wasteReports);

  return [
    ...groupBy(
      actionableWasteReports,
      (report) => `${report.category}::${report.recommendation}`,
    ).entries(),
  ]
    .map(([key, reports]) => {
      const [category, recommendation] = key.split("::");
      const severities = ["low", "medium", "high", "critical"] as const;
      const priority =
        reports
          .map((report) => report.severity)
          .sort((left, right) => severities.indexOf(right) - severities.indexOf(left))[0] ?? "low";

      return {
        category,
        description: recommendation,
        affectedTraces: new Set(reports.map((report) => report.traceId)).size,
        estimatedSavingsUsd: sumBy(
          reports,
          (report) => report.estimatedSavingsUsd ?? report.wastedCostUsd,
        ),
        priority,
      };
    })
    .sort((left, right) => right.estimatedSavingsUsd - left.estimatedSavingsUsd);
}

export function sortTraces(traces: Array<TraceRecord & { wasteUsd: number }>, sort: string) {
  return [...traces].sort((left, right) => {
    switch (sort) {
      case "cost_asc":
        return left.totalCostUsd - right.totalCostUsd;
      case "waste_desc":
        return right.wasteUsd - left.wasteUsd;
      case "waste_asc":
        return left.wasteUsd - right.wasteUsd;
      case "date_asc":
        return left.startedAt.getTime() - right.startedAt.getTime();
      case "cost_desc":
        return right.totalCostUsd - left.totalCostUsd;
      default:
        return right.startedAt.getTime() - left.startedAt.getTime();
    }
  });
}

export function serializeTraceSummary(
  trace: TraceRecord,
  wasteReports: WasteReportRecord[],
  spanCount: number,
) {
  const actionableWasteReports = getActionableWasteReports(wasteReports);
  const rawWaste = sumBy(actionableWasteReports, (report) => report.wastedCostUsd);
  return {
    ...trace,
    spanCount,
    wasteUsd: Math.min(rawWaste, trace.totalCostUsd),
    wasteCount: actionableWasteReports.length,
  };
}

export function normalizeTraceDetail(
  trace: TraceRecord,
  spans: SpanRecord[],
  segments: SegmentRecord[],
  wasteReports: WasteReportRecord[],
) {
  return {
    trace: serializeTraceSummary(trace, wasteReports, spans.length),
    spans,
    segments,
    costBreakdown: buildCostBreakdown(trace, segments, wasteReports),
    wasteReports,
    topSpans: getTopSpans(spans, 5),
  };
}

export function getTraceMessages(messages: MessageRecord[]) {
  return messages;
}
