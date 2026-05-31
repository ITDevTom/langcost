/**
 * Contracts for the modular, opt-in waste-detection ruleset.
 *
 * These are pure, serializable shapes (no behavior, no imports) so they can be
 * persisted via the settings repository and shared across db, analyzers, the
 * API, and the web app without dragging analyzer/db code into `@langcost/core`.
 * The behavioral rule contract (`WasteRule`) lives in `@langcost/analyzers`,
 * because it is typed against analyzer/db records and would break this package's
 * zero-dep invariant.
 *
 * See `RULESETS.md` for the full design.
 */

/** Normalized data a rule needs to produce findings. Used to gate + explain per-adapter behavior. */
export type DataRequirement = "messages" | "cacheTokens" | "toolDefs" | "spans";

/** Per-rule user configuration. A rule runs iff `enabled === true` (strict opt-in). */
export interface RuleConfigEntry {
  enabled: boolean;
  /** `"*"` = all adapters (incl. future ones); otherwise an allow-list of `trace.source` values. */
  sources: "*" | string[];
  /** Overrides merged over the rule's `defaultThresholds`. */
  thresholds?: Record<string, number>;
}

/** The persisted ruleset configuration (stored under the `rules_config` settings key). */
export interface RulesConfig {
  rules: Record<string, RuleConfigEntry>;
}

/** Whether a catalog entry is a cost (waste) rule or a fault-attribution rule. */
export type RuleKind = "cost" | "fault";

/** Serializable rule metadata surfaced to the CLI / API / dashboard. */
export interface RuleCatalogEntry {
  id: string;
  kind: RuleKind;
  tier: 1 | 2;
  title: string;
  description: string;
  /** UI pre-check hint for onboarding. Never an auto-run set — detection is strictly opt-in. */
  defaultEnabled: boolean;
  requires: DataRequirement[];
  defaultThresholds: Record<string, number>;
}
