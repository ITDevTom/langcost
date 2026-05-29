import type { RuleCatalogEntry, RulesConfig } from "@langcost/core";

import { agentLoopsRule } from "./agent-loops";
import { cacheExpiryRule } from "./cache-expiry";
import { highOutputRule } from "./high-output";
import { lowCacheRule } from "./low-cache";
import { modelOveruseRule } from "./model-overuse";
import { retryPatternsRule } from "./retry-patterns";
import { toolFailuresRule } from "./tool-failures";
import type { ResolvedRuleConfig, WasteRule } from "./types";

/**
 * Built-in rules. This is the registry seam: today it is populated statically; a future rule-pack
 * loader can register additional rules here without touching the runner (see `RULESETS.md` §10).
 * Detection is strictly opt-in — a rule only runs when enabled in `rules_config`.
 */
const BUILTIN_RULES: readonly WasteRule[] = [
  lowCacheRule,
  modelOveruseRule,
  agentLoopsRule,
  retryPatternsRule,
  toolFailuresRule,
  highOutputRule,
  cacheExpiryRule,
];

const registry = new Map<string, WasteRule>(BUILTIN_RULES.map((rule) => [rule.id, rule]));

/** Serializable metadata for every registered rule — surfaced to the CLI / API / dashboard. */
export function getRuleCatalog(): RuleCatalogEntry[] {
  return [...registry.values()].map((rule) => ({
    id: rule.id,
    tier: rule.tier,
    title: rule.title,
    description: rule.description,
    defaultEnabled: rule.defaultEnabled,
    requires: rule.requires ?? [],
    defaultThresholds: rule.defaultThresholds ?? {},
  }));
}

/** A rule selected to run, with its resolved thresholds and adapter scope. */
export interface ResolvedRule {
  rule: WasteRule;
  resolved: ResolvedRuleConfig;
  /** `"*"` = all adapters; otherwise the allow-list of `trace.source` values to run against. */
  sources: "*" | string[];
}

/**
 * Resolve the active rule set from persisted config. Strict opt-in: a null/absent config yields an
 * empty set, and only rules with `enabled === true` are returned.
 */
export function resolveRules(config: RulesConfig | null | undefined): ResolvedRule[] {
  if (!config?.rules) {
    return [];
  }

  const active: ResolvedRule[] = [];
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

/**
 * Build a config that enables every registered rule against all adapters. Used by onboarding's
 * "select all" affordance and by tests that need detection turned on.
 */
export function allRulesEnabledConfig(): RulesConfig {
  return {
    rules: Object.fromEntries(
      getRuleCatalog().map((entry) => [entry.id, { enabled: true, sources: "*" as const }]),
    ),
  };
}
