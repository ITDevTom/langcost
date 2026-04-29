import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { IngestOptions } from "@langcost/core";

import type { DiscoveredConversationFile, DiscoveredProject } from "./types";

const DEFAULT_CLAUDE_ROOT = join(process.env.HOME ?? ".", ".claude");

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

/**
 * Derive the original filesystem path and a short project name from
 * the Claude Code directory name convention.
 *
 * e.g. "-Users-vijaysingh-code-langcost" → {
 *   originalPath: "/Users/vijaysingh/code/langcost",
 *   projectName: "langcost"
 * }
 */
function parseProjectDirectory(dirName: string): { originalPath: string; projectName: string } {
  const originalPath = dirName.replace(/^-/, "/").replace(/-/g, "/");
  const projectName = originalPath.split("/").filter(Boolean).pop() ?? dirName;
  return { originalPath, projectName };
}

export function getClaudeCodeRoot(sourcePath?: string): string {
  return expandHomePath(sourcePath ?? DEFAULT_CLAUDE_ROOT);
}

export function getProjectsRoot(sourcePath?: string): string {
  return join(getClaudeCodeRoot(sourcePath), "projects");
}

async function discoverFromSingleFile(
  filePath: string,
  since?: Date,
): Promise<DiscoveredConversationFile[]> {
  const expandedPath = expandHomePath(filePath);
  const stats = await stat(expandedPath);
  const modifiedAt = stats.mtime;

  if (!stats.isFile() || !expandedPath.endsWith(".jsonl") || !isWithinSince(modifiedAt, since)) {
    return [];
  }

  const parts = expandedPath.split("/");
  const projectDirIndex = parts.findIndex((_, i) => i > 0 && parts[i - 1] === "projects");
  const projectDirName = (projectDirIndex >= 0 ? parts[projectDirIndex] : undefined) ?? "unknown";
  const parsed = parseProjectDirectory(projectDirName);

  return [
    {
      filePath: expandedPath,
      fileSize: stats.size,
      modifiedAt,
      conversationId: basename(expandedPath, ".jsonl"),
      project: {
        projectPath: projectDirName,
        projectName: parsed.projectName,
        originalPath: parsed.originalPath,
      },
    },
  ];
}

async function discoverSubagents(
  conversationDir: string,
  conversationId: string,
  project: DiscoveredProject,
  since?: Date,
): Promise<DiscoveredConversationFile[]> {
  const subagentsDir = join(conversationDir, "subagents");
  const discovered: DiscoveredConversationFile[] = [];

  try {
    const entries = await readdir(subagentsDir, { withFileTypes: true, encoding: "utf8" });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = join(subagentsDir, entry.name);
      const stats = await stat(filePath);
      const modifiedAt = stats.mtime;

      if (!isWithinSince(modifiedAt, since)) {
        continue;
      }

      discovered.push({
        filePath,
        fileSize: stats.size,
        modifiedAt,
        conversationId: `${conversationId}:${basename(entry.name, ".jsonl")}`,
        project,
        parentConversationId: conversationId,
        subagentId: basename(entry.name, ".jsonl"),
      });
    }
  } catch {}

  return discovered;
}

async function discoverFromProject(
  projectsRoot: string,
  projectDirName: string,
  since?: Date,
): Promise<DiscoveredConversationFile[]> {
  const projectDir = join(projectsRoot, projectDirName);
  const parsed = parseProjectDirectory(projectDirName);
  const project: DiscoveredProject = {
    projectPath: projectDirName,
    projectName: parsed.projectName,
    originalPath: parsed.originalPath,
  };

  const discovered: DiscoveredConversationFile[] = [];

  try {
    const entries = await readdir(projectDir, { withFileTypes: true, encoding: "utf8" });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const filePath = join(projectDir, entry.name);
        const stats = await stat(filePath);
        const modifiedAt = stats.mtime;

        if (!isWithinSince(modifiedAt, since)) {
          continue;
        }

        const conversationId = basename(entry.name, ".jsonl");

        discovered.push({
          filePath,
          fileSize: stats.size,
          modifiedAt,
          conversationId,
          project,
        });

        // Scan subagents directory for this conversation
        const conversationDir = join(projectDir, conversationId);
        const subagents = await discoverSubagents(conversationDir, conversationId, project, since);
        discovered.push(...subagents);
      }
    }
  } catch {}

  return discovered;
}

async function discoverAllProjects(
  sourcePath?: string,
  since?: Date,
  projectFilter?: string,
): Promise<DiscoveredConversationFile[]> {
  const projectsRoot = getProjectsRoot(sourcePath);
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true, encoding: "utf8" });
  const discovered: DiscoveredConversationFile[] = [];

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) {
      continue;
    }

    if (projectFilter) {
      const parsed = parseProjectDirectory(dir.name);
      const filterLower = projectFilter.toLowerCase();
      const matchesName = parsed.projectName.toLowerCase() === filterLower;
      const matchesPath = parsed.originalPath.toLowerCase().includes(filterLower);
      const matchesDirName = dir.name.toLowerCase().includes(filterLower);

      if (!matchesName && !matchesPath && !matchesDirName) {
        continue;
      }
    }

    const projectFiles = await discoverFromProject(projectsRoot, dir.name, since);
    discovered.push(...projectFiles);
  }

  discovered.sort((left, right) => {
    const dateDelta = left.modifiedAt.getTime() - right.modifiedAt.getTime();
    return dateDelta !== 0 ? dateDelta : left.filePath.localeCompare(right.filePath);
  });

  return discovered;
}

export async function discoverConversationFiles(
  options: Pick<IngestOptions, "file" | "since" | "sourcePath"> & {
    project?: string | undefined;
  } = {},
): Promise<DiscoveredConversationFile[]> {
  if (options.file) {
    return discoverFromSingleFile(options.file, options.since);
  }

  return discoverAllProjects(options.sourcePath, options.since, options.project);
}
