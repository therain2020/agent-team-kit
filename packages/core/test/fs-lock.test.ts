import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLockTimeoutError, acquireFileLock } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function lockPath(name = "test.lock"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-lock-"));
  roots.push(root);
  return path.join(root, name);
}

describe("file lock", () => {
  it("acquires and releases a lock", async () => {
    const target = await lockPath();
    const lock = await acquireFileLock(target);
    expect(lock.isHeld()).toBe(true);
    expect(existsSync(target)).toBe(true);

    lock.release();
    expect(lock.isHeld()).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a second holder until the first releases", async () => {
    const target = await lockPath();
    const first = await acquireFileLock(target, { staleMs: 60_000 });

    await expect(
      acquireFileLock(target, {
        timeoutMs: 150,
        pollMs: 20,
        staleMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    first.release();
    const second = await acquireFileLock(target, { timeoutMs: 1_000 });
    expect(second.isHeld()).toBe(true);
    second.release();
  });

  it("takes over a lock owned by a dead process", async () => {
    const target = await lockPath();
    const at = new Date().toISOString();
    await writeFile(
      target,
      JSON.stringify({
        token: "dead-token",
        pid: 999_999,
        hostname: os.hostname(),
        owner: "dead",
        acquiredAt: at,
        heartbeatAt: at,
      }),
      "utf8",
    );

    const lock = await acquireFileLock(target, {
      timeoutMs: 500,
      staleMs: 60_000,
    });
    expect(lock.isHeld()).toBe(true);
    lock.release();
  });

  it("does not remove a lock it no longer owns", async () => {
    const target = await lockPath();
    const lock = await acquireFileLock(target, { staleMs: 60_000 });
    const at = new Date().toISOString();
    await writeFile(
      target,
      JSON.stringify({
        token: "someone-else",
        pid: process.pid,
        hostname: os.hostname(),
        owner: "other",
        acquiredAt: at,
        heartbeatAt: at,
      }),
      "utf8",
    );

    expect(lock.isHeld()).toBe(false);
    lock.release();
    expect(existsSync(target)).toBe(true);
  });
});
