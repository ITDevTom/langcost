import { createDb, createSettingsRepository, getSqliteClient, migrate } from "@langcost/db";

import { createPalette } from "../output/colors";
import type {
  CliRuntime,
  DashboardCommandOptions,
  DashboardModule,
  DashboardServer,
} from "../types";

async function loadDashboardModule(): Promise<DashboardModule> {
  try {
    return (await import("@langcost/api")) as DashboardModule;
  } catch {
    return (await import(
      new URL("../../../../apps/api/src/index.ts", import.meta.url).href
    )) as DashboardModule;
  }
}

function hasConfiguredSource(dbPath?: string): boolean {
  const db = createDb(dbPath);

  try {
    migrate(db);
    return Boolean(createSettingsRepository(db).getSourceConfig()?.source);
  } finally {
    getSqliteClient(db).close(false);
  }
}

function openCommand(url: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

async function openBrowser(url: string): Promise<void> {
  const command = openCommand(url);
  const child = Bun.spawn({
    cmd: command,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    throw new Error(`Browser open command failed with exit code ${exitCode}.`);
  }
}

async function waitForShutdown(server: DashboardServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      server.stop(true);
      resolve();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export async function runDashboardCommand(
  options: DashboardCommandOptions,
  runtime: CliRuntime,
): Promise<number> {
  const palette = createPalette(runtime.io);
  const dashboardModule = runtime.dashboard?.loadModule
    ? await runtime.dashboard.loadModule()
    : await loadDashboardModule();
  const server = dashboardModule.startApiServer(options.port, {
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
  });
  const url = `http://localhost:${server.port}`;

  runtime.io.write(`${palette.green("Dashboard running:")} ${url}\n`);

  if (hasConfiguredSource(options.dbPath)) {
    try {
      const result = await dashboardModule.runConfiguredScan(options.dbPath, false);
      runtime.io.write(
        `${palette.blue("Auto-scan complete:")} ${result.tracesIngested} traces, ${result.spansIngested} spans, ${result.messagesIngested} messages.\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown scan error";
      runtime.io.error(`${palette.red("Auto-scan failed:")} ${message}\n`);
    }
  } else {
    runtime.io.write(
      `${palette.yellow("No source configured:")} open the dashboard setup screen to connect one.\n`,
    );
  }

  if (!options.noOpen) {
    try {
      const open = runtime.dashboard?.openUrl ?? openBrowser;
      await open(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser error";
      runtime.io.error(`${palette.yellow("Open failed:")} ${message}\n`);
    }
  }

  runtime.io.write(`Press Ctrl+C to stop the dashboard server.\n`);

  const holdOpen = runtime.dashboard?.waitForShutdown ?? waitForShutdown;
  await holdOpen(server);
  return 0;
}
