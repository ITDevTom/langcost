import { createSettingsRepository } from "@langcost/db";
import { Hono } from "hono";

import { withDb } from "../lib/db";

export function createSettingsRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.get("/", async (c) => {
    const response = await withDb(options.dbPath, (db) => {
      const config = createSettingsRepository(db).getSourceConfig();

      return {
        ...(config?.source ? { source: config.source } : {}),
        ...(config?.sourcePath ? { sourcePath: config.sourcePath } : {}),
        ...(config?.apiUrl ? { apiUrl: config.apiUrl } : {}),
        hasApiKey: Boolean(config?.apiKey),
      };
    });

    return c.json(response);
  });

  route.put("/", async (c) => {
    const body = await c.req.json();
    if (typeof body?.source !== "string" || body.source.length === 0) {
      return c.json({ ok: false, error: "source is required" }, 400);
    }

    await withDb(options.dbPath, (db) => {
      createSettingsRepository(db).setSourceConfig({
        source: body.source,
        ...(typeof body.sourcePath === "string" && body.sourcePath.length > 0
          ? { sourcePath: body.sourcePath }
          : {}),
        ...(typeof body.apiKey === "string" && body.apiKey.length > 0
          ? { apiKey: body.apiKey }
          : {}),
        ...(typeof body.apiUrl === "string" && body.apiUrl.length > 0
          ? { apiUrl: body.apiUrl }
          : {}),
      });
    });

    return c.json({ ok: true });
  });

  return route;
}
