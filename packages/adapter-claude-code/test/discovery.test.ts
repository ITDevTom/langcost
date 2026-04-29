import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverConversationFiles } from "../src/discovery";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function createFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "langcost-claude-code-discovery-"));
  cleanupPaths.push(root);

  const projectDir = join(root, "projects", "-Users-test-code-myproject");
  mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

function copyFixture(targetDir: string, fileName = "simple-conversation.jsonl") {
  const fixturePath = join(process.cwd(), "fixtures", "claude-code", fileName);
  const copiedPath = join(targetDir, "conv-001.jsonl");
  copyFileSync(fixturePath, copiedPath);
  return copiedPath;
}

describe("discoverConversationFiles", () => {
  it("finds JSONL files under projects/*", async () => {
    const { root, projectDir } = createFixtureRoot();
    const copiedPath = copyFixture(projectDir);

    const discovered = await discoverConversationFiles({ sourcePath: root });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.conversationId).toBe("conv-001");
    expect(discovered[0]?.filePath).toBe(copiedPath);
  });

  it("parses project name from directory name", async () => {
    const { root, projectDir } = createFixtureRoot();
    copyFixture(projectDir);

    const discovered = await discoverConversationFiles({ sourcePath: root });

    expect(discovered[0]?.project.projectName).toBe("myproject");
    expect(discovered[0]?.project.originalPath).toBe("/Users/test/code/myproject");
  });

  it("discovers files across multiple projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "langcost-claude-code-multi-"));
    cleanupPaths.push(root);

    const project1 = join(root, "projects", "-Users-test-code-alpha");
    const project2 = join(root, "projects", "-Users-test-code-beta");
    mkdirSync(project1, { recursive: true });
    mkdirSync(project2, { recursive: true });

    copyFixture(project1);
    const fixturePath = join(process.cwd(), "fixtures", "claude-code", "simple-conversation.jsonl");
    copyFileSync(fixturePath, join(project2, "conv-002.jsonl"));

    const discovered = await discoverConversationFiles({ sourcePath: root });

    expect(discovered).toHaveLength(2);
    const projects = discovered.map((d) => d.project.projectName);
    expect(projects).toContain("alpha");
    expect(projects).toContain("beta");
  });

  it("filters files by the since date", async () => {
    const { root, projectDir } = createFixtureRoot();
    const fixturePath = join(process.cwd(), "fixtures", "claude-code", "simple-conversation.jsonl");

    const oldPath = join(projectDir, "old-conv.jsonl");
    const newPath = join(projectDir, "new-conv.jsonl");
    copyFileSync(fixturePath, oldPath);
    copyFileSync(fixturePath, newPath);

    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    const newDate = new Date("2026-04-01T00:00:00.000Z");
    utimesSync(oldPath, oldDate, oldDate);
    utimesSync(newPath, newDate, newDate);

    const discovered = await discoverConversationFiles({
      sourcePath: root,
      since: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.conversationId).toBe("new-conv");
  });

  it("filters by project name", async () => {
    const root = mkdtempSync(join(tmpdir(), "langcost-claude-code-filter-"));
    cleanupPaths.push(root);

    const project1 = join(root, "projects", "-Users-test-code-alpha");
    const project2 = join(root, "projects", "-Users-test-code-beta");
    mkdirSync(project1, { recursive: true });
    mkdirSync(project2, { recursive: true });

    copyFixture(project1);
    const fixturePath = join(process.cwd(), "fixtures", "claude-code", "simple-conversation.jsonl");
    copyFileSync(fixturePath, join(project2, "conv-002.jsonl"));

    const discovered = await discoverConversationFiles({
      sourcePath: root,
      project: "alpha",
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.project.projectName).toBe("alpha");
  });

  it("discovers a single file by path", async () => {
    const fixturePath = join(process.cwd(), "fixtures", "claude-code", "simple-conversation.jsonl");

    const discovered = await discoverConversationFiles({ file: fixturePath });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.conversationId).toBe("simple-conversation");
  });

  it("skips non-JSONL files", async () => {
    const { root, projectDir } = createFixtureRoot();
    copyFixture(projectDir);

    // Create a non-JSONL file
    await Bun.write(join(projectDir, "notes.txt"), "not a JSONL file");

    const discovered = await discoverConversationFiles({ sourcePath: root });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.filePath.endsWith(".jsonl")).toBe(true);
  });

  it("handles project names with special path segments", async () => {
    const root = mkdtempSync(join(tmpdir(), "langcost-claude-code-special-"));
    cleanupPaths.push(root);

    const projectDir = join(
      root,
      "projects",
      "-Users-vijaysingh-SastrifyCode-sastrix-app--claude-worktrees-dreamy-neumann",
    );
    mkdirSync(projectDir, { recursive: true });
    copyFixture(projectDir);

    const discovered = await discoverConversationFiles({ sourcePath: root });

    expect(discovered).toHaveLength(1);
    // Last segment after splitting by /
    expect(discovered[0]?.project.projectName).toBe("neumann");
  });
});
