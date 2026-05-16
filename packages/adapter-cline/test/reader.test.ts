import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTaskFile } from "../src/reader";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("readTaskFile", () => {
  it("reports malformed api_conversation_history.json and normalizes it to an empty array", async () => {
    const root = mkdtempSync(join(tmpdir(), "langcost-cline-reader-"));
    cleanupPaths.push(root);

    const taskDir = join(root, "tasks", "task-1");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const uiMessagesPath = join(taskDir, "ui_messages.json");
    writeFileSync(uiMessagesPath, "[]");
    writeFileSync(join(taskDir, "api_conversation_history.json"), "{}");
    writeFileSync(join(root, "state", "taskHistory.json"), "[]");

    const result = await readTaskFile(uiMessagesPath, root);

    expect(result.apiConversationHistory).toEqual([]);
    expect(result.errors).toContainEqual({
      message: "api_conversation_history.json: expected top-level array",
    });
  });
});
