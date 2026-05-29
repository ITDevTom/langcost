import { getRuleCatalog, runPipeline, wasteDetector } from "@langcost/analyzers";
import type { RulesConfig } from "@langcost/core";
import { createSettingsRepository, createTraceRepository } from "@langcost/db";
import { Hono } from "hono";

import { withDb } from "../lib/db";

function isValidRulesConfig(value: unknown): value is RulesConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rules = (value as { rules?: unknown }).rules;
  if (!rules || typeof rules !== "object") {
    return false;
  }

  for (const entry of Object.values(rules as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { enabled?: unknown; sources?: unknown; thresholds?: unknown };
    if (typeof candidate.enabled !== "boolean") {
      return false;
    }
    const validSources =
      candidate.sources === "*" ||
      (Array.isArray(candidate.sources) && candidate.sources.every((s) => typeof s === "string"));
    if (!validSources) {
      return false;
    }
    if (candidate.thresholds !== undefined) {
      if (typeof candidate.thresholds !== "object" || candidate.thresholds === null) {
        return false;
      }
      const numericValues = Object.values(candidate.thresholds as Record<string, unknown>).every(
        (n) => typeof n === "number" && Number.isFinite(n),
      );
      if (!numericValues) {
        return false;
      }
    }
  }

  return true;
}

export function createRulesRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  // Catalog of available rules + the persisted (opt-in) configuration.
  route.get("/", async (c) => {
    const payload = await withDb(options.dbPath, (db) => {
      const config = createSettingsRepository(db).getRulesConfig() ?? { rules: {} };
      return { catalog: getRuleCatalog(), config };
    });
    return c.json(payload);
  });

  // Persist the configuration and re-run waste detection over already-ingested traces
  // (no re-ingest). Disabling/removing a rule drops its findings via the delete-then-insert path.
  route.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isValidRulesConfig(body)) {
      return c.json(
        {
          ok: false,
          error:
            'Invalid rules config. Expected { rules: { <id>: { enabled: boolean, sources: "*" | string[], thresholds?: Record<string, number> } } }.',
        },
        400,
      );
    }

    const result = await withDb(options.dbPath, async (db) => {
      createSettingsRepository(db).setRulesConfig(body);

      const traceIds = createTraceRepository(db)
        .listForAnalysis()
        .map((trace) => trace.id);
      if (traceIds.length === 0) {
        return { tracesAnalyzed: 0, findingsCount: 0 };
      }

      const pipeline = await runPipeline(db, [wasteDetector], { traceIds });
      return { tracesAnalyzed: pipeline.tracesAnalyzed, findingsCount: pipeline.findingsCount };
    });

    return c.json({ ok: true, ...result });
  });

  return route;
}
