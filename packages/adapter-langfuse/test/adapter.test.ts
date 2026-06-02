import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, createTraceRepository, migrate } from "@langcost/db";

import { langfuseAdapter } from "../src/adapter";

const cleanupPaths: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) rmSync(path, { force: true, recursive: true });
  }
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "langcost-langfuse-"));
  cleanupPaths.push(dir);
  const db = createDb(join(dir, "langcost.db"));
  migrate(db);
  return db;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const OBS = {
  id: "obs-1",
  traceId: "trace-1",
  type: "GENERATION",
  startTime: new Date().toISOString(),
  model: "claude-haiku-4-5-20251001",
  usageDetails: { input: 100, output: 20 },
};

const TRACE = {
  id: "trace-1",
  timestamp: new Date().toISOString(),
  name: "agent-run",
  sessionId: "sess-1",
  tags: ["prod"],
};

describe("langfuseAdapter.ingest", () => {
  it("pulls a default ~30-day window and ingests via the bulk traces list (no per-trace N+1)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/api/public/v2/observations")) {
        return jsonResponse({ data: [OBS], meta: { cursor: null } });
      }
      if (url.includes("/api/public/traces?")) {
        return jsonResponse({ data: [TRACE], meta: { page: 1, totalPages: 1 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = freshDb();
    const result = await langfuseAdapter.ingest(db, {
      apiKey: "pk-lf-test:sk-lf-test",
      apiUrl: "https://example.test",
    });

    expect(result.tracesIngested).toBe(1);
    expect(result.spansIngested).toBe(1);
    expect(result.errors).toEqual([]);

    // The bulk traces LIST is used; the per-trace GET /traces/{id} N+1 is gone.
    expect(calls.some((u) => u.includes("/api/public/traces?"))).toBe(true);
    expect(calls.some((u) => /\/api\/public\/traces\/[^?]/.test(u))).toBe(false);

    // Default window: both endpoints are lower-bounded ~30 days back (no `since` given).
    const obsUrl = calls.find((u) => u.includes("/observations")) ?? "";
    const from = new URL(obsUrl).searchParams.get("fromStartTime");
    expect(from).toBeTruthy();
    const ageDays = (Date.now() - new Date(from as string).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);

    // The trace was actually normalized + written.
    expect(createTraceRepository(db).getById("langfuse:trace-1")?.sessionKey).toBe("sess-1");
  });

  it("retries on HTTP 429, honoring Retry-After", async () => {
    let obsCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/public/v2/observations")) {
        obsCalls += 1;
        if (obsCalls === 1) {
          // Fractional Retry-After keeps the test fast (~50ms) while exercising the backoff path.
          return new Response("rate limited", { status: 429, headers: { "retry-after": "0.05" } });
        }
        return jsonResponse({ data: [OBS], meta: { cursor: null } });
      }
      if (url.includes("/api/public/traces?")) {
        return jsonResponse({ data: [TRACE], meta: { page: 1, totalPages: 1 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const db = freshDb();
    const result = await langfuseAdapter.ingest(db, {
      apiKey: "pk-lf-test:sk-lf-test",
      apiUrl: "https://example.test",
    });

    expect(obsCalls).toBe(2); // first 429, then retried successfully
    expect(result.tracesIngested).toBe(1);
  });
});
