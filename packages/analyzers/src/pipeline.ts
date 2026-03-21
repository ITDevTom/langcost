import type { AnalyzeOptions, AnalyzeResult, IAnalyzer } from "@langcost/core";
import type { Db } from "@langcost/db";
import { createAnalysisRunRepository } from "@langcost/db";

import { costAnalyzer } from "./cost-analyzer";
import { wasteDetector } from "./waste-detector";

export interface PipelineAnalyzerResult {
  analyzerName: string;
  result: AnalyzeResult;
}

export interface PipelineResult {
  tracesAnalyzed: number;
  findingsCount: number;
  durationMs: number;
  analyzerResults: PipelineAnalyzerResult[];
}

export const defaultAnalyzers: IAnalyzer<Db>[] = [costAnalyzer, wasteDetector];

export async function runPipeline(
  db: Db,
  analyzers: IAnalyzer<Db>[] = defaultAnalyzers,
  options?: AnalyzeOptions,
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const analysisRunRepository = createAnalysisRunRepository(db);
  const analyzerResults: PipelineAnalyzerResult[] = [];

  for (const analyzer of [...analyzers].sort(
    (left, right) => left.meta.priority - right.meta.priority,
  )) {
    const runId = crypto.randomUUID();
    const runStartedAt = new Date();

    analysisRunRepository.upsert({
      id: runId,
      analyzerName: analyzer.meta.name,
      startedAt: runStartedAt,
      completedAt: null,
      tracesAnalyzed: 0,
      findingsCount: 0,
      status: "running",
      errorMessage: null,
    });

    try {
      const result = await analyzer.analyze(db, options);
      analyzerResults.push({
        analyzerName: analyzer.meta.name,
        result,
      });

      analysisRunRepository.upsert({
        id: runId,
        analyzerName: analyzer.meta.name,
        startedAt: runStartedAt,
        completedAt: new Date(),
        tracesAnalyzed: result.tracesAnalyzed,
        findingsCount: result.findingsCount,
        status: "complete",
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown pipeline error";

      analysisRunRepository.upsert({
        id: runId,
        analyzerName: analyzer.meta.name,
        startedAt: runStartedAt,
        completedAt: new Date(),
        tracesAnalyzed: 0,
        findingsCount: 0,
        status: "error",
        errorMessage: message,
      });

      throw error;
    }
  }

  return {
    tracesAnalyzed: analyzerResults.reduce(
      (max, entry) => Math.max(max, entry.result.tracesAnalyzed),
      0,
    ),
    findingsCount: analyzerResults.reduce((sum, entry) => sum + entry.result.findingsCount, 0),
    durationMs: Date.now() - startedAt,
    analyzerResults,
  };
}
