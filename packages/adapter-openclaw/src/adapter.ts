import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { IAdapter, IngestOptions, IngestResult } from "@langcost/core";
import type { Db } from "@langcost/db";
import {
  createIngestionStateRepository,
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
  getSqliteClient,
} from "@langcost/db";

import { discoverSessionFiles, resolveOpenClawRoot } from "./discovery";
import { normalizeSession } from "./normalizer";
import { readSessionFile } from "./reader";

async function filterAlreadyIngested(db: Db, options: IngestOptions | undefined) {
  const ingestionRepository = createIngestionStateRepository(db);
  const discovered = await discoverSessionFiles(options);

  if (options?.force) {
    return { discovered, skipped: 0 };
  }

  const pending = [];
  let skipped = 0;

  for (const session of discovered) {
    const existing = ingestionRepository.getBySourcePath(session.filePath);
    if (
      existing &&
      existing.lastOffset === session.fileSize &&
      session.modifiedAt.getTime() <= existing.updatedAt.getTime()
    ) {
      skipped += 1;
      continue;
    }

    pending.push(session);
  }

  return { discovered: pending, skipped };
}

export const openClawAdapter: IAdapter<Db> = {
  meta: {
    name: "openclaw",
    version: "0.0.1",
    description: "Ingest OpenClaw JSONL sessions from local disk into langcost SQLite.",
    sourceType: "local",
  },

  async validate(options?: IngestOptions) {
    try {
      if (options?.file) {
        const discovered = await discoverSessionFiles(options);
        return discovered.length > 0
          ? { ok: true, message: `Found OpenClaw session file at ${options.file}` }
          : { ok: false, message: `OpenClaw session file not found: ${options.file}` };
      }

      const resolved = await resolveOpenClawRoot(options?.sourcePath);

      if (!options?.sourcePath && !resolved.autoDiscovered) {
        return {
          ok: false,
          message: `OpenClaw not found in default locations (${resolved.tried.join(", ")}). If you have it installed elsewhere, set the path in Settings.`,
        };
      }

      if (options?.sourcePath) {
        const agentsPath = join(resolved.root, "agents");
        try {
          const info = await stat(agentsPath);
          if (!info.isDirectory()) {
            return {
              ok: false,
              message: `OpenClaw agents directory not found: ${agentsPath}. Check your source path in Settings.`,
            };
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {
              ok: false,
              message: `OpenClaw agents directory not found: ${agentsPath}. Check your source path in Settings.`,
            };
          }
          throw error;
        }
      }

      const discovered = await discoverSessionFiles(options);
      return discovered.length > 0
        ? {
            ok: true,
            message: `Found ${discovered.length} OpenClaw session files under ${resolved.root}`,
          }
        : { ok: false, message: `No OpenClaw session files found under ${resolved.root}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown validation failure";
      return { ok: false, message };
    }
  },

  async ingest(db: Db, options?: IngestOptions): Promise<IngestResult> {
    const startedAt = Date.now();
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const ingestionRepository = createIngestionStateRepository(db);
    const sqlite = getSqliteClient(db);

    const { discovered, skipped } = await filterAlreadyIngested(db, options);
    const errors: IngestResult["errors"] = [];

    let tracesIngested = 0;
    let spansIngested = 0;
    let messagesIngested = 0;

    options?.onProgress?.({
      phase: "discovering",
      current: discovered.length,
      total: discovered.length,
    });

    for (const [index, session] of discovered.entries()) {
      options?.onProgress?.({
        phase: "reading",
        current: index + 1,
        total: discovered.length,
        sessionId: session.sessionId,
      });

      const readResult = await readSessionFile(session.filePath);

      options?.onProgress?.({
        phase: "normalizing",
        current: index + 1,
        total: discovered.length,
        sessionId: session.sessionId,
      });

      const normalized = normalizeSession(session, readResult);
      errors.push(...normalized.errors);

      options?.onProgress?.({
        phase: "writing",
        current: index + 1,
        total: discovered.length,
        sessionId: session.sessionId,
      });

      // Single transaction per session: collapses hundreds of upserts into one
      // short writer-lock hold, reducing collision odds with other scan processes.
      sqlite.transaction(() => {
        traceRepository.upsert(normalized.trace);
        for (const span of normalized.spans) {
          spanRepository.upsert(span);
        }
        for (const message of normalized.messages) {
          messageRepository.upsert(message);
        }
        ingestionRepository.upsert({
          sourcePath: session.filePath,
          adapter: "openclaw",
          lastOffset: readResult.lastOffset,
          lastLineHash: readResult.lastLineHash,
          lastSessionId: session.sessionId,
          updatedAt: new Date(),
        });
      })();

      tracesIngested += 1;
      spansIngested += normalized.spans.length;
      messagesIngested += normalized.messages.length;
    }

    return {
      tracesIngested,
      spansIngested,
      messagesIngested,
      skipped,
      errors,
      durationMs: Date.now() - startedAt,
    };
  },
};
