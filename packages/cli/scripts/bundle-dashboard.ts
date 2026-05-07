#!/usr/bin/env bun
/**
 * Bundles apps/api/src and apps/web/dist into packages/cli/dashboard/ so the
 * `langcost` npm tarball ships a self-contained dashboard.
 *
 * See ARCHITECTURE.md (Option C) for why this exists.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const cliDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(cliDir, "..", "..");
const apiSrc = resolve(repoRoot, "apps", "api", "src");
const webDir = resolve(repoRoot, "apps", "web");
const webDist = resolve(webDir, "dist");
const bundleDir = resolve(cliDir, "dashboard");
const bundleApi = resolve(bundleDir, "api");
const bundleWeb = resolve(bundleDir, "web");

function run(command: [string, ...string[]], cwd: string) {
  console.log(`$ ${command.join(" ")}  (cwd: ${cwd})`);
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

if (!existsSync(apiSrc)) {
  throw new Error(`apps/api/src not found at ${apiSrc}`);
}

console.log("Building web app...");
run(["bun", "run", "build"], webDir);

if (!existsSync(webDist)) {
  throw new Error(`Web build did not produce ${webDist}`);
}

console.log(`Cleaning ${bundleDir}`);
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

console.log(`Copying API source: ${apiSrc} -> ${bundleApi}`);
cpSync(apiSrc, bundleApi, { recursive: true });

console.log(`Copying web build: ${webDist} -> ${bundleWeb}`);
cpSync(webDist, bundleWeb, { recursive: true });

console.log("Dashboard bundle ready at packages/cli/dashboard/");
