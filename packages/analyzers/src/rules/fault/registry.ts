import type { RuleCatalogEntry, RulesConfig } from "@langcost/core";

import type { ResolvedRuleConfig } from "../types";
import { silentToolMisuseRule } from "./silent-tool-misuse";
import { toolCascadeRule } from "./tool-cascade";
import type { FaultRule } from "./types";

/**
 * Built-in fault-attribution rules. Parallel to the cost `BUILTIN_RULES`: a static registry seam,
 * strictly opt-in via the shared `rules_config` (keyed by rule id), per-source scoped.
 */
const BUILTIN_FAULT_RULES: readonly FaultRule[] = [toolCascadeRule, silentToolMisuseRule];

const registry = new Map<string, FaultRule>(BUILTIN_FAULT_RULES.map((rule) => [rule.id, rule]));

/** Serializable metadata for every fault rule (faults are informational tier 2 in the catalog). */
export function getFaultRuleCatalog(): RuleCatalogEntry[] {
  return [...registry.values()].map((rule) => ({
    id: rule.id,
    kind: "fault" as const,
    tier: 2,
    title: rule.title,
    description: rule.description,
    defaultEnabled: rule.defaultEnabled,
    requires: rule.requires ?? [],
    defaultThresholds: rule.defaultThresholds ?? {},
  }));
}

export interface ResolvedFaultRule {
  rule: FaultRule;
  resolved: ResolvedRuleConfig;
  /** `"*"` = all adapters; otherwise the allow-list of `trace.source` values. */
  sources: "*" | string[];
}

/** Resolve the active fault rules from persisted config. Strict opt-in, same as the cost rules. */
export function resolveFaultRules(config: RulesConfig | null | undefined): ResolvedFaultRule[] {
  if (!config?.rules) {
    return [];
  }
  const active: ResolvedFaultRule[] = [];
  for (const rule of registry.values()) {
    const entry = config.rules[rule.id];
    if (!entry?.enabled) {
      continue;
    }
    active.push({
      rule,
      resolved: {
        thresholds: { ...(rule.defaultThresholds ?? {}), ...(entry.thresholds ?? {}) },
      },
      sources: entry.sources ?? "*",
    });
  }
  return active;
}

/** Enable every fault rule against all adapters (onboarding "select all" / tests). */
export function allFaultRulesEnabledConfig(): RulesConfig {
  return {
    rules: Object.fromEntries(
      getFaultRuleCatalog().map((entry) => [entry.id, { enabled: true, sources: "*" as const }]),
    ),
  };
}
