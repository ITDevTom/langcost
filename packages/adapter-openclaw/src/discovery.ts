import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { IngestOptions } from "@langcost/core";

import type { DiscoveredSessionFile } from "./types";

const DEFAULT_OPENCLAW_ROOT = join(process.env.HOME ?? ".", ".openclaw");

function expandHomePath(path: string): string {
  const home = process.env.HOME;
  if (!home) {
    return path;
  }

  if (path === "~") {
    return home;
  }

  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }

  return path;
}

function isWithinSince(modifiedAt: Date, since?: Date): boolean {
  return since ? modifiedAt.getTime() >= since.getTime() : true;
}

function extractAgentId(filePath: string): string | undefined {
  const parts = filePath.split("/");
  const agentsIndex = parts.lastIndexOf("agents");
  if (agentsIndex === -1 || agentsIndex + 1 >= parts.length) {
    return undefined;
  }

  return parts[agentsIndex + 1];
}

export function getOpenClawRoot(sourcePath?: string): string {
  return expandHomePath(sourcePath ?? DEFAULT_OPENCLAW_ROOT);
}

async function discoverFromSingleFile(
  filePath: string,
  since?: Date,
): Promise<DiscoveredSessionFile[]> {
  const stats = await stat(filePath);
  const modifiedAt = stats.mtime;
  const agentId = extractAgentId(filePath);

  if (!stats.isFile() || !filePath.endsWith(".jsonl") || !isWithinSince(modifiedAt, since)) {
    return [];
  }

  return [
    {
      ...(agentId ? { agentId } : {}),
      filePath,
      fileSize: stats.size,
      modifiedAt,
      sessionId: basename(filePath, ".jsonl"),
    },
  ];
}

async function discoverFromRoot(rootPath: string, since?: Date): Promise<DiscoveredSessionFile[]> {
  const agentsPath = join(rootPath, "agents");
  const agentDirectories = await readdir(agentsPath, { withFileTypes: true, encoding: "utf8" });
  const discovered: DiscoveredSessionFile[] = [];

  for (const entry of agentDirectories) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionsPath = join(agentsPath, entry.name, "sessions");
    try {
      const sessionFiles = await readdir(sessionsPath, { withFileTypes: true, encoding: "utf8" });

      for (const sessionFile of sessionFiles) {
        if (!sessionFile.isFile() || !sessionFile.name.endsWith(".jsonl")) {
          continue;
        }

        const filePath = join(sessionsPath, sessionFile.name);
        const stats = await stat(filePath);
        const modifiedAt = stats.mtime;
        if (!isWithinSince(modifiedAt, since)) {
          continue;
        }

        discovered.push({
          agentId: entry.name,
          filePath,
          fileSize: stats.size,
          modifiedAt,
          sessionId: basename(sessionFile.name, ".jsonl"),
        });
      }
    } catch {}
  }

  discovered.sort((left, right) => {
    const dateDelta = left.modifiedAt.getTime() - right.modifiedAt.getTime();
    return dateDelta !== 0 ? dateDelta : left.filePath.localeCompare(right.filePath);
  });

  return discovered;
}

export async function discoverSessionFiles(
  options: Pick<IngestOptions, "file" | "since" | "sourcePath"> = {},
): Promise<DiscoveredSessionFile[]> {
  if (options.file) {
    return discoverFromSingleFile(expandHomePath(options.file), options.since);
  }

  return discoverFromRoot(getOpenClawRoot(options.sourcePath), options.since);
}
