import { stat } from "node:fs/promises";

import type { IAdapter, IngestOptions, IngestResult } from "@langcost/core";
import type { Db } from "@langcost/db";
import {
  createIngestionStateRepository,
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
} from "@langcost/db";

import { discoverConversationFiles, getProjectsRoot } from "./discovery";
import { normalizeConversation } from "./normalizer";
import { readConversationFile } from "./reader";

export interface ClaudeCodeIngestOptions extends IngestOptions {
  project?: string | undefined;
}

async function filterAlreadyIngested(db: Db, options: ClaudeCodeIngestOptions | undefined) {
  const ingestionRepository = createIngestionStateRepository(db);
  const discovered = await discoverConversationFiles({
    file: options?.file,
    since: options?.since,
    sourcePath: options?.sourcePath,
    project: options?.project,
  });

  if (options?.force) {
    return { discovered, skipped: 0 };
  }

  const pending = [];
  let skipped = 0;

  for (const conversation of discovered) {
    const existing = ingestionRepository.getBySourcePath(conversation.filePath);
    if (
      existing &&
      existing.lastOffset === conversation.fileSize &&
      conversation.modifiedAt.getTime() <= existing.updatedAt.getTime()
    ) {
      skipped += 1;
      continue;
    }

    pending.push(conversation);
  }

  return { discovered: pending, skipped };
}

export const claudeCodeAdapter: IAdapter<Db> = {
  meta: {
    name: "claude-code",
    version: "0.1.0",
    description: "Ingest Claude Code conversation logs from local disk into langcost SQLite.",
    sourceType: "local",
  },

  async validate(options?: ClaudeCodeIngestOptions) {
    try {
      if (options?.file) {
        const discovered = await discoverConversationFiles(options);
        return discovered.length > 0
          ? { ok: true, message: `Found Claude Code conversation file at ${options.file}` }
          : { ok: false, message: `Claude Code conversation file not found: ${options.file}` };
      }

      const projectsRoot = getProjectsRoot(options?.sourcePath);

      try {
        const projectsDirectory = await stat(projectsRoot);
        if (!projectsDirectory.isDirectory()) {
          return {
            ok: false,
            message: `Claude Code projects directory not found: ${projectsRoot}`,
          };
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return {
            ok: false,
            message: `Claude Code projects directory not found: ${projectsRoot}. Is Claude Code installed?`,
          };
        }

        throw error;
      }

      const discovered = await discoverConversationFiles({
        ...options,
        project: options?.project,
      });
      return discovered.length > 0
        ? { ok: true, message: `Found ${discovered.length} Claude Code conversation files` }
        : { ok: false, message: `No Claude Code conversation files found under ${projectsRoot}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown validation failure";
      return { ok: false, message };
    }
  },

  async ingest(db: Db, options?: ClaudeCodeIngestOptions): Promise<IngestResult> {
    const startedAt = Date.now();
    const traceRepository = createTraceRepository(db);
    const spanRepository = createSpanRepository(db);
    const messageRepository = createMessageRepository(db);
    const ingestionRepository = createIngestionStateRepository(db);

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

    for (const [index, conversation] of discovered.entries()) {
      options?.onProgress?.({
        phase: "reading",
        current: index + 1,
        total: discovered.length,
        sessionId: conversation.conversationId,
      });

      const readResult = await readConversationFile(conversation.filePath);

      options?.onProgress?.({
        phase: "normalizing",
        current: index + 1,
        total: discovered.length,
        sessionId: conversation.conversationId,
      });

      const normalized = normalizeConversation(conversation, readResult);
      errors.push(...normalized.errors);

      options?.onProgress?.({
        phase: "writing",
        current: index + 1,
        total: discovered.length,
        sessionId: conversation.conversationId,
      });

      traceRepository.upsert(normalized.trace);
      for (const span of normalized.spans) {
        spanRepository.upsert(span);
      }
      for (const message of normalized.messages) {
        messageRepository.upsert(message);
      }
      ingestionRepository.upsert({
        sourcePath: conversation.filePath,
        adapter: "claude-code",
        lastOffset: readResult.lastOffset,
        lastLineHash: readResult.lastLineHash,
        lastSessionId: conversation.conversationId,
        updatedAt: new Date(),
      });

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
