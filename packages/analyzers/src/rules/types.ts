import type { DataRequirement } from "@langcost/core";
import type { WasteReportRecord } from "@langcost/db";

import type { TraceAnalysisContext } from "../context";

/** Per-rule configuration resolved by the registry (defaults merged with user overrides). */
export interface ResolvedRuleConfig {
  thresholds: Record<string, number>;
}

export interface WasteRule {
  /** Stable, unique identifier. Used as the key in `rules_config`. */
  readonly id: string;
  readonly tier: 1 | 2;
  /** Human-readable label for the catalog / dashboard. */
  readonly title: string;
  readonly description: string;
  /** UI pre-check hint only — detection is strictly opt-in, so this never auto-enables a rule. */
  readonly defaultEnabled: boolean;
  /** Normalized data the rule needs; the runner skips traces that lack it. */
  readonly requires?: DataRequirement[];
  readonly defaultThresholds?: Record<string, number>;
  detect(contexts: TraceAnalysisContext[], config?: ResolvedRuleConfig): WasteReportRecord[];
}
