import type { DataRequirement } from "@langcost/core";
import type { FaultReportRecord } from "@langcost/db";

import type { TraceAnalysisContext } from "../../context";
import type { ResolvedRuleConfig } from "../types";

/**
 * A fault-attribution rule. Mirrors `WasteRule` but emits `FaultReportRecord[]` into `fault_reports`
 * instead of `waste_reports`. Same opt-in + per-source + `requires` gating model as the cost rules,
 * resolved from the shared `rules_config` by `id`.
 */
export interface FaultRule {
  /** Stable, unique id (e.g. "fault-tool-cascade"); the key in `rules_config`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** UI pre-check hint only — detection is strictly opt-in. */
  readonly defaultEnabled: boolean;
  /** Normalized data the rule needs; the runner skips traces that lack it. */
  readonly requires?: DataRequirement[];
  readonly defaultThresholds?: Record<string, number>;
  detect(contexts: TraceAnalysisContext[], config?: ResolvedRuleConfig): FaultReportRecord[];
}
