import { describe, expect, it } from "bun:test";

import { allRulesEnabledConfig, getRuleCatalog, resolveRules } from "../src/index";

describe("rule registry", () => {
  it("exposes catalog metadata for every built-in rule", () => {
    const catalog = getRuleCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(7);
    for (const entry of catalog) {
      expect(typeof entry.id).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect([1, 2]).toContain(entry.tier);
      expect(Array.isArray(entry.requires)).toBe(true);
    }
    expect(catalog.map((entry) => entry.id)).toContain("low-cache");
  });

  it("resolves to nothing when config is absent or empty (strict opt-in)", () => {
    expect(resolveRules(null)).toEqual([]);
    expect(resolveRules(undefined)).toEqual([]);
    expect(resolveRules({ rules: {} })).toEqual([]);
  });

  it("returns only enabled rules and ignores disabled ones", () => {
    const active = resolveRules({
      rules: {
        "low-cache": { enabled: true, sources: "*" },
        "high-output": { enabled: false, sources: "*" },
      },
    });
    expect(active.map((entry) => entry.rule.id)).toEqual(["low-cache"]);
  });

  it("merges user thresholds over rule defaults and carries adapter scope", () => {
    const active = resolveRules({
      rules: {
        "agent-loops": { enabled: true, sources: ["openclaw"], thresholds: { minRepeats: 9 } },
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.sources).toEqual(["openclaw"]);
    expect(active[0]?.resolved.thresholds.minRepeats).toBe(9);
  });

  it("allRulesEnabledConfig enables every rule against all adapters", () => {
    const config = allRulesEnabledConfig();
    const ids = getRuleCatalog().map((entry) => entry.id);
    for (const id of ids) {
      expect(config.rules[id]).toEqual({ enabled: true, sources: "*" });
    }
    expect(resolveRules(config)).toHaveLength(ids.length);
  });
});
