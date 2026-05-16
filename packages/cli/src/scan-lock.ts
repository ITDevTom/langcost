import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CliIo } from "./types";

interface LockPayload {
  pid: number;
  startedAt: string;
  command: string;
}

interface ScanLock {
  release(): void;
}

const POLL_INTERVAL_MS = 500;
const STALE_NOTICE_INTERVAL_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 5 * 60_000;

export function scanLockPath(dbPath: string): string {
  return join(dirname(dbPath), "scan.lock");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a no-op probe — throws ESRCH if the process is gone.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      // Process exists but we lack permission to signal it. Treat as alive.
      return true;
    }
    return false;
  }
}

function readLock(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: typeof parsed.command === "string" ? parsed.command : "",
    };
  } catch {
    return null;
  }
}

function tryCreateLock(lockPath: string, payload: LockPayload): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
  return true;
}

function removeIfOurs(lockPath: string, pid: number): void {
  const existing = readLock(lockPath);
  if (!existing || existing.pid !== pid) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore — another process may have already cleaned it up.
  }
}

export async function acquireScanLock(dbPath: string, io: CliIo): Promise<ScanLock> {
  const lockPath = scanLockPath(dbPath);
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.argv.slice(2).join(" "),
  };

  const startedWaitingAt = Date.now();
  let announced = false;
  let lastNoticeAt = 0;

  while (true) {
    if (tryCreateLock(lockPath, payload)) break;

    const existing = readLock(lockPath);
    if (!existing || !isProcessAlive(existing.pid)) {
      // Stale lock (process gone, or unparseable contents). Reclaim it.
      try {
        unlinkSync(lockPath);
      } catch {}
      continue;
    }

    if (Date.now() - startedWaitingAt > ACQUIRE_TIMEOUT_MS) {
      throw new Error(
        `Timed out after 5 minutes waiting for another scan (pid ${existing.pid}, started ${existing.startedAt}) to finish. ` +
          `If that process is stuck, remove ${lockPath} and retry.`,
      );
    }

    if (!announced) {
      io.write(
        `Another scan is running (pid ${existing.pid}, started ${existing.startedAt}) — waiting…\n`,
      );
      announced = true;
      lastNoticeAt = Date.now();
    } else if (Date.now() - lastNoticeAt > STALE_NOTICE_INTERVAL_MS) {
      const waitedSec = Math.round((Date.now() - startedWaitingAt) / 1000);
      io.write(`Still waiting (${waitedSec}s)…\n`);
      lastNoticeAt = Date.now();
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  const release = () => removeIfOurs(lockPath, payload.pid);

  // Best-effort cleanup if the process is killed mid-scan. The lockfile is
  // idempotent — leaving it behind only delays the next scan briefly, since
  // we detect stale locks via PID liveness above.
  const onSignal = () => {
    release();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return {
    release: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      release();
    },
  };
}
