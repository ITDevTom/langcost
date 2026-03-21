import { Hono } from "hono";

import { runConfiguredScan } from "../lib/scan";

export function createScanRoute(options: { dbPath?: string } = {}) {
  const route = new Hono();

  route.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const force = body && typeof body.force === "boolean" ? body.force : false;

    try {
      const result = await runConfiguredScan(options.dbPath, force);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown scan failure" },
        400,
      );
    }
  });

  return route;
}
