#!/usr/bin/env bun

import { runDashboardCommand } from "./commands/dashboard";
import { runReportCommand } from "./commands/report";
import { runScanCommand } from "./commands/scan";
import { runStatusCommand } from "./commands/status";
import { getHelpText, parseArgv } from "./config";
import type { CliRuntime } from "./types";

function createRuntime(partial: Partial<CliRuntime> = {}): CliRuntime {
  return {
    io: partial.io ?? {
      write(message: string) {
        process.stdout.write(message);
      },
      error(message: string) {
        process.stderr.write(message);
      },
      useColor: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
    },
    now: partial.now ?? (() => new Date()),
    ...(partial.dashboard ? { dashboard: partial.dashboard } : {}),
  };
}

export async function main(
  argv: string[],
  partialRuntime: Partial<CliRuntime> = {},
): Promise<number> {
  const runtime = createRuntime(partialRuntime);

  try {
    const command = parseArgv(argv, runtime.now());

    if (command.command === "help") {
      runtime.io.write(`${getHelpText()}\n`);
      return 0;
    }

    switch (command.command) {
      case "scan":
        return runScanCommand(command, runtime);
      case "report":
        return runReportCommand(command, runtime);
      case "status":
        return runStatusCommand(command, runtime);
      case "dashboard":
        return runDashboardCommand(command, runtime);
      default:
        runtime.io.error(`Unknown command.\n`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI failure";
    runtime.io.error(`${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
