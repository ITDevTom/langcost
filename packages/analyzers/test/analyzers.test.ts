import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAnalysisRunRepository,
  createDb,
  createSegmentRepository,
  createSettingsRepository,
  createTraceRepository,
  createWasteReportRepository,
  getSqliteClient,
  migrate,
} from "@langcost/db";

import { openClawAdapter } from "../../adapter-openclaw/src/index";
import { allRulesEnabledConfig, costAnalyzer, runPipeline, wasteDetector } from "../src/index";

function enableAllRules(db: ReturnType<typeof createDb>) {
  createSettingsRepository(db).setRulesConfig(allRulesEnabledConfig());
}

const cleanupPaths: string[] = [];
const cleanupDatabases: Database[] = [];

afterEach(() => {
  while (cleanupDatabases.length > 0) {
    cleanupDatabases.pop()?.close(false);
  }

  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function createTempDb() {
  const directory = mkdtempSync(join(tmpdir(), "langcost-analyzers-db-"));
  cleanupPaths.push(directory);

  const db = createDb(join(directory, "langcost.db"));
  migrate(db);
  cleanupDatabases.push(getSqliteClient(db));
  return db;
}

async function ingestFixture(db: ReturnType<typeof createDb>, fixtureName: string) {
  const fixture = join(process.cwd(), "fixtures", "openclaw", fixtureName);
  await openClawAdapter.ingest(db, { file: fixture });

  const trace = createTraceRepository(db)
    .listForAnalysis()
    .find((candidate) => String(candidate.metadata?.sourceFile ?? "").endsWith(fixtureName));

  if (!trace) {
    throw new Error(`Trace not found for fixture ${fixtureName}`);
  }

  return trace;
}

function readSourceFiles(rootPath: string): string[] {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...readSourceFiles(path));
      continue;
    }

    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

describe("@langcost/analyzers", () => {
  it("costAnalyzer aggregates span usage into coarse segments", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "simple-session.jsonl");

    const result = await costAnalyzer.analyze(db, { traceIds: [trace.id] });
    const segments = createSegmentRepository(db).listByTraceId(trace.id);
    const totalSegmentCost = segments.reduce((sum, segment) => sum + segment.costUsd, 0);

    expect(result.tracesAnalyzed).toBe(1);
    expect(result.findingsCount).toBeGreaterThan(0);
    expect(segments.some((segment) => segment.type === "user_query")).toBe(true);
    expect(segments.some((segment) => segment.type === "assistant_response")).toBe(true);
    expect(segments.some((segment) => segment.type === "tool_result")).toBe(true);
    expect(totalSegmentCost).toBeCloseTo(trace.totalCostUsd, 8);
  });

  it("detects low cache utilization", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "expensive-session.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "low_cache_utilization")).toBe(true);
  });

  it("detects expensive model overuse", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "model-overuse-session.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "model_overuse")).toBe(true);
  });

  it("detects agent loops", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "agent-loop.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "agent_loop")).toBe(true);
  });

  it("detects retry patterns", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "retry-session.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "retry_waste")).toBe(true);
  });

  it("does not flag tool failures the agent treated as a signal (no retry)", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "tool-heavy.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "tool_failure_waste")).toBe(false);
  });

  it("detects unusually high output spans", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "high-output-session.jsonl");

    enableAllRules(db);
    await wasteDetector.analyze(db, { traceIds: [trace.id] });

    const reports = createWasteReportRepository(db).listByTraceId(trace.id);
    expect(reports.some((report) => report.category === "high_output")).toBe(true);
  });

  it("runs no rules and writes no waste reports when rules_config is absent (strict opt-in)", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "expensive-session.jsonl");

    const result = await wasteDetector.analyze(db, { traceIds: [trace.id] });

    expect(result.findingsCount).toBe(0);
    expect(createWasteReportRepository(db).listByTraceId(trace.id)).toHaveLength(0);
  });

  it("only runs a rule against the adapters it is scoped to", async () => {
    const db = createTempDb();
    const trace = await ingestFixture(db, "expensive-session.jsonl"); // source = openclaw

    const hasLowCache = () =>
      createWasteReportRepository(db)
        .listByTraceId(trace.id)
        .some((report) => report.category === "low_cache_utilization");

    // Scoped to a different adapter -> low-cache must not run on this openclaw trace.
    createSettingsRepository(db).setRulesConfig({
      rules: { "low-cache": { enabled: true, sources: ["langfuse"] } },
    });
    await wasteDetector.analyze(db, { traceIds: [trace.id] });
    expect(hasLowCache()).toBe(false);

    // Re-scope to openclaw -> low-cache now runs against this trace.
    createSettingsRepository(db).setRulesConfig({
      rules: { "low-cache": { enabled: true, sources: ["openclaw"] } },
    });
    await wasteDetector.analyze(db, { traceIds: [trace.id] });
    expect(hasLowCache()).toBe(true);
  });

  it("runs analyzers in priority order and records analysis_runs", async () => {
    const db = createTempDb();
    const simpleTrace = await ingestFixture(db, "simple-session.jsonl");
    const toolTrace = await ingestFixture(db, "tool-heavy.jsonl");

    const result = await runPipeline(db, undefined, {
      traceIds: [simpleTrace.id, toolTrace.id],
    });

    const runs = createAnalysisRunRepository(db).listAll();

    expect(result.analyzerResults.map((entry) => entry.analyzerName)).toEqual([
      "cost-analyzer",
      "waste-detector",
      "fault-detector",
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.analyzerName)).toEqual([
      "cost-analyzer",
      "waste-detector",
      "fault-detector",
    ]);
    expect(runs.every((run) => run.status === "complete")).toBe(true);
  });

  it("keeps analyzer source free of adapter-specific references", () => {
    const sourceFiles = readSourceFiles(join(process.cwd(), "packages", "analyzers", "src"));

    for (const sourceFile of sourceFiles) {
      const content = readFileSync(sourceFile, "utf8");
      expect(content.toLowerCase().includes("openclaw")).toBe(false);
    }
  });
});
