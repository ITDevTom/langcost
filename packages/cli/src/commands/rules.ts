import { getRuleCatalog, runPipeline, wasteDetector } from "@langcost/analyzers";
import type { RuleConfigEntry, RulesConfig } from "@langcost/core";
import {
  createDb,
  createSettingsRepository,
  createTraceRepository,
  type Db,
  getSqliteClient,
  migrate,
  resolveDbPath,
} from "@langcost/db";

import { createPalette } from "../output/colors";
import type { CliRuntime, RulesCommandOptions } from "../types";

type Palette = ReturnType<typeof createPalette>;

async function reanalyzeStoredTraces(
  db: Db,
): Promise<{ tracesAnalyzed: number; findings: number }> {
  const traceIds = createTraceRepository(db)
    .listForAnalysis()
    .map((trace) => trace.id);
  if (traceIds.length === 0) {
    return { tracesAnalyzed: 0, findings: 0 };
  }
  const result = await runPipeline(db, [wasteDetector], { traceIds });
  return { tracesAnalyzed: result.tracesAnalyzed, findings: result.findingsCount };
}

function loadConfig(db: Db): RulesConfig {
  return createSettingsRepository(db).getRulesConfig() ?? { rules: {} };
}

function writeConfig(db: Db, config: RulesConfig): void {
  createSettingsRepository(db).setRulesConfig(config);
}

function knownRuleIds(): Set<string> {
  return new Set(getRuleCatalog().map((entry) => entry.id));
}

function requireKnownRule(ruleId: string, runtime: CliRuntime, palette: Palette): boolean {
  if (knownRuleIds().has(ruleId)) {
    return true;
  }
  const valid = [...knownRuleIds()].sort().join(", ");
  runtime.io.error(`${palette.red("Error:")} unknown rule "${ruleId}". Available: ${valid}\n`);
  return false;
}

function printList(db: Db, runtime: CliRuntime, palette: Palette): void {
  const config = loadConfig(db);
  const catalog = getRuleCatalog();

  const rows = catalog.map((entry) => {
    const ruleConfig = config.rules[entry.id];
    const enabled = ruleConfig?.enabled === true;
    const scope = !enabled
      ? "-"
      : ruleConfig?.sources === "*"
        ? "all"
        : (ruleConfig?.sources ?? []).join(",");
    const thresholds =
      ruleConfig?.thresholds && Object.keys(ruleConfig.thresholds).length > 0
        ? Object.entries(ruleConfig.thresholds)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")
        : "-";
    return { id: entry.id, tier: `T${entry.tier}`, enabled, scope, thresholds };
  });

  const idWidth = Math.max(4, ...rows.map((row) => row.id.length));
  const scopeWidth = Math.max(5, ...rows.map((row) => row.scope.length));

  runtime.io.write(
    `${palette.bold(`${"RULE".padEnd(idWidth)}  TIER  ENABLED  ${"SCOPE".padEnd(scopeWidth)}  THRESHOLDS`)}\n`,
  );
  for (const row of rows) {
    const enabledCell = row.enabled ? palette.green("yes    ") : palette.dim("no     ");
    runtime.io.write(
      `${row.id.padEnd(idWidth)}  ${row.tier.padEnd(4)}  ${enabledCell}  ${row.scope.padEnd(scopeWidth)}  ${row.thresholds}\n`,
    );
  }

  const enabledCount = rows.filter((row) => row.enabled).length;
  if (enabledCount === 0) {
    runtime.io.write(
      `\n${palette.yellow("No rules enabled.")} Waste detection is opt-in — enable rules with ${palette.cyan("langcost rules enable <id>")}.\n`,
    );
  }
}

function mutateEntry(
  config: RulesConfig,
  ruleId: string,
  update: (current: RuleConfigEntry) => RuleConfigEntry,
): RulesConfig {
  const current: RuleConfigEntry = config.rules[ruleId] ?? { enabled: false, sources: "*" };
  return { rules: { ...config.rules, [ruleId]: update(current) } };
}

export async function runRulesCommand(
  options: RulesCommandOptions,
  runtime: CliRuntime,
): Promise<number> {
  const palette = createPalette(runtime.io);
  const dbPath = resolveDbPath(options.dbPath);
  const db = createDb(dbPath);

  try {
    migrate(db);

    if (options.action === "list") {
      printList(db, runtime, palette);
      return 0;
    }

    if (options.action === "apply") {
      const { tracesAnalyzed, findings } = await reanalyzeStoredTraces(db);
      runtime.io.write(`Re-analyzed ${tracesAnalyzed} trace(s); ${findings} waste finding(s).\n`);
      return 0;
    }

    const ruleId = options.ruleId;
    if (!ruleId || !requireKnownRule(ruleId, runtime, palette)) {
      return 1;
    }

    let config = loadConfig(db);
    let summary: string;

    switch (options.action) {
      case "enable":
        config = mutateEntry(config, ruleId, (current) => ({ ...current, enabled: true }));
        summary = `Enabled "${ruleId}".`;
        break;
      case "disable":
        config = mutateEntry(config, ruleId, (current) => ({ ...current, enabled: false }));
        summary = `Disabled "${ruleId}".`;
        break;
      case "scope": {
        const sources = options.sources ?? "*";
        config = mutateEntry(config, ruleId, (current) => ({
          ...current,
          enabled: true,
          sources,
        }));
        const label = sources === "*" ? "all adapters" : sources.join(", ");
        summary = `Scoped "${ruleId}" to ${label}.`;
        break;
      }
      case "set": {
        const key = options.thresholdKey;
        const value = options.thresholdValue;
        if (!key || value === undefined) {
          runtime.io.error(`${palette.red("Error:")} rules set requires <key> <value>.\n`);
          return 1;
        }
        config = mutateEntry(config, ruleId, (current) => ({
          ...current,
          thresholds: { ...(current.thresholds ?? {}), [key]: value },
        }));
        summary = `Set ${ruleId}.${key} = ${value}.`;
        break;
      }
      default:
        runtime.io.error(`${palette.red("Error:")} unknown rules action.\n`);
        return 1;
    }

    writeConfig(db, config);
    const { tracesAnalyzed, findings } = await reanalyzeStoredTraces(db);
    runtime.io.write(
      `${summary} Re-analyzed ${tracesAnalyzed} trace(s); ${findings} waste finding(s).\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown rules failure";
    runtime.io.error(`${palette.red("Error:")} ${message}\n`);
    return 1;
  } finally {
    getSqliteClient(db).close(false);
  }
}
