import type { WasteReportRecord } from "@langcost/db";

import type { TraceAnalysisContext } from "../context";

export interface WasteRule {
  readonly name: string;
  readonly tier: 1 | 2;
  detect(contexts: TraceAnalysisContext[]): WasteReportRecord[];
}
