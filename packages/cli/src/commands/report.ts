import {
  createDb,
  createSegmentRepository,
  createSpanRepository,
  createTraceRepository,
  createWasteReportRepository,
  getSqliteClient,
  migrate,
} from "@langcost/db";

import { createPalette } from "../output/colors";
import { formatCurrency, formatDateTime, pluralize } from "../output/summary";
import { renderMarkdownTable, renderTable, type TableColumn } from "../output/table";
import type { CliRuntime, ReportCommandOptions } from "../types";

function formatReportRows(
  rows: Array<Record<string, string>>,
  columns: TableColumn[],
  format: ReportCommandOptions["format"],
): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);
    case "markdown":
      return renderMarkdownTable(columns, rows);
    default:
      return renderTable(columns, rows);
  }
}

export async function runReportCommand(
  options: ReportCommandOptions,
  runtime: CliRuntime,
): Promise<number> {
  const palette = createPalette(runtime.io);
  const db = createDb(options.dbPath);

  try {
    migrate(db);

    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const segmentRepository = createSegmentRepository(db);
    const wasteRepository = createWasteReportRepository(db);

    if (options.traceId) {
      const trace = traceRepository.getById(options.traceId);
      if (!trace) {
        runtime.io.error(`${palette.red("Error:")} Trace not found: ${options.traceId}\n`);
        return 1;
      }

      const spans = spanRepository.listByTraceId(trace.id);
      const segments = segmentRepository.listByTraceId(trace.id);
      const wasteReports = wasteRepository
        .listByTraceId(trace.id)
        .filter((report) => !options.category || report.category === options.category);

      if (options.format === "json") {
        runtime.io.write(
          `${JSON.stringify({ trace, spans, segments, reports: wasteReports }, null, 2)}\n`,
        );
        return 0;
      }

      const spanColumns: TableColumn[] = [
        { key: "type", label: "Type" },
        { key: "name", label: "Name" },
        { key: "model", label: "Model" },
        { key: "cost", label: "Cost", align: "right" },
        { key: "status", label: "Status" },
      ];
      const spanRows = spans.map((span) => ({
        type: span.type,
        name: span.name ?? span.toolName ?? "-",
        model: span.model ?? "-",
        cost: formatCurrency(span.costUsd ?? 0),
        status: span.status,
      }));

      const wasteColumns: TableColumn[] = [
        { key: "category", label: "Category" },
        { key: "severity", label: "Severity" },
        { key: "waste", label: "Waste", align: "right" },
        { key: "recommendation", label: "Recommendation" },
      ];
      const wasteRows = wasteReports.map((report) => ({
        category: report.category,
        severity: report.severity,
        waste: formatCurrency(report.wastedCostUsd),
        recommendation: report.recommendation,
      }));

      const sections = [
        `${palette.bold("Trace")} ${trace.id}`,
        `Started: ${formatDateTime(trace.startedAt)}`,
        `Cost: ${formatCurrency(trace.totalCostUsd)}`,
        `Status: ${trace.status}`,
        "",
        `${palette.bold("Spans")} (${pluralize(spans.length, "span")})`,
        formatReportRows(spanRows, spanColumns, options.format),
        "",
        `${palette.bold("Waste Reports")} (${pluralize(wasteReports.length, "report")})`,
        wasteRows.length > 0
          ? formatReportRows(wasteRows, wasteColumns, options.format)
          : "No waste reports.",
      ];

      runtime.io.write(`${sections.join("\n")}\n`);
      return 0;
    }

    const wasteByTrace = new Map<string, number>();
    for (const report of wasteRepository.list()) {
      if (options.category && report.category !== options.category) {
        continue;
      }

      wasteByTrace.set(
        report.traceId,
        (wasteByTrace.get(report.traceId) ?? 0) + report.wastedCostUsd,
      );
    }

    let traces = traceRepository.listForAnalysis();
    if (options.category) {
      traces = traces.filter((trace) => wasteByTrace.has(trace.id));
    }

    traces.sort((left, right) => {
      switch (options.sort) {
        case "cost":
          return right.totalCostUsd - left.totalCostUsd;
        case "waste":
          return (wasteByTrace.get(right.id) ?? 0) - (wasteByTrace.get(left.id) ?? 0);
        default:
          return right.startedAt.getTime() - left.startedAt.getTime();
      }
    });

    const rows = traces.slice(0, options.limit).map((trace) => ({
      trace: trace.id,
      started: formatDateTime(trace.startedAt),
      model: trace.model ?? "-",
      status: trace.status,
      cost: formatCurrency(trace.totalCostUsd),
      waste: formatCurrency(wasteByTrace.get(trace.id) ?? 0),
    }));

    const columns: TableColumn[] = [
      { key: "trace", label: "Trace" },
      { key: "started", label: "Started" },
      { key: "model", label: "Model" },
      { key: "status", label: "Status" },
      { key: "cost", label: "Cost", align: "right" },
      { key: "waste", label: "Waste", align: "right" },
    ];

    runtime.io.write(`${formatReportRows(rows, columns, options.format)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown report failure";
    runtime.io.error(`${palette.red("Error:")} ${message}\n`);
    return 1;
  } finally {
    getSqliteClient(db).close(false);
  }
}
