import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

interface LockMeta {
  token: string;
  pid: number;
  hostname: string;
  owner: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface FileLockOptions {
  /** Time to wait for a busy lock. Default 60s. */
  timeoutMs?: number;
  /** Take over a lock whose heartbeat is older than this. Default 15min. */
  staleMs?: number;
  /** How often the owner refreshes the lock mtime. Default 10s. */
  heartbeatMs?: number;
  /** Poll interval while waiting. Default 250ms. */
  pollMs?: number;
  owner?: string;
  hostname?: string;
}

export interface FileLockHandle {
  readonly path: string;
  readonly token: string;
  /** True while the on-disk lock still belongs to this handle. */
  isHeld(): boolean;
  /** Refresh the heartbeat and mtime if still owned. */
  touch(): void;
  /** Remove the lock only if this handle still owns it. */
  release(): void;
}

export class FileLockTimeoutError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: string | undefined,
  ) {
    super(
      `timed out waiting for file lock ${lockPath}${holder ? ` (held by ${holder})` : ""}`,
    );
    this.name = "FileLockTimeoutError";
  }
}

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  const resolved = path.resolve(lockPath);
  mkdirSync(path.dirname(resolved), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 60_000;
  const staleMs = options.staleMs ?? 15 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const pollMs = options.pollMs ?? 250;
  const hostname = options.hostname ?? os.hostname();
  const owner = options.owner ?? `${process.pid}@${hostname}`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const token = randomUUID();
    const at = new Date().toISOString();
    const meta: LockMeta = {
      token,
      pid: process.pid,
      hostname,
      owner,
      acquiredAt: at,
      heartbeatAt: at,
    };

    try {
      writeFileSync(resolved, JSON.stringify(meta), {
        encoding: "utf8",
        flag: "wx",
      });
      return createHandle(resolved, meta, heartbeatMs);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }

    const existing = readLockMeta(resolved);
    if (isStale(resolved, existing, staleMs, hostname)) {
      try {
        unlinkSync(resolved);
      } catch {
        // Another contender may have removed it first.
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(resolved, existing?.owner);
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(resolved, existing?.owner);
    }
    await delay(pollMs);
  }
}

function createHandle(
  lockPath: string,
  meta: LockMeta,
  heartbeatMs: number,
): FileLockHandle {
  let released = false;
  let lost = false;

  const heartbeat = setInterval(() => {
    if (released || lost) {
      return;
    }
    const current = readLockMeta(lockPath);
    if (current?.token !== meta.token) {
      lost = true;
      clearInterval(heartbeat);
      return;
    }
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      lost = true;
      clearInterval(heartbeat);
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const refresh = (): void => {
    if (released || lost) {
      return;
    }
    const current = readLockMeta(lockPath);
    if (current?.token !== meta.token) {
      lost = true;
      return;
    }
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      lost = true;
    }
  };

  return {
    path: lockPath,
    token: meta.token,
    isHeld(): boolean {
      if (released || lost) {
        return false;
      }
      return readLockMeta(lockPath)?.token === meta.token;
    },
    touch: refresh,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      const current = readLockMeta(lockPath);
      if (current?.token !== meta.token) {
        return;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Already removed.
      }
    },
  };
}

function isStale(
  lockPath: string,
  meta: LockMeta | null,
  staleMs: number,
  hostname: string,
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }

  if (Date.now() - mtimeMs > staleMs) {
    return true;
  }
  if (meta && meta.hostname === hostname && !isPidAlive(meta.pid)) {
    return true;
  }
  return false;
}

function readLockMeta(lockPath: string): LockMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockMeta).token === "string" &&
      typeof (parsed as LockMeta).pid === "number" &&
      typeof (parsed as LockMeta).hostname === "string" &&
      typeof (parsed as LockMeta).owner === "string"
    ) {
      return parsed as LockMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
