import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendActivity } from "@kit/activity";
import {
  CLI_ERROR_CODES,
  CLI_EXIT_CODE_TABLE,
  CliError,
  classifyError,
  exitCodeForCode,
  exitCodeForError,
  ok,
} from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerApprove } from "../src/commands/approve";
import { registerAutonomy } from "../src/commands/autonomy";
import { registerBootstrap } from "../src/commands/bootstrap";
import { registerDemo } from "../src/commands/demo";
import { registerDev } from "../src/commands/dev";
import { registerDoctor } from "../src/commands/doctor";
import { registerEvent } from "../src/commands/event";
import { registerEvolve } from "../src/commands/evolve";
import { registerInit } from "../src/commands/init";
import { registerIterate } from "../src/commands/iterate";
import { registerJob } from "../src/commands/job";
import { registerKillSwitch } from "../src/commands/kill-switch";
import { registerManager } from "../src/commands/manager";
import { registerModel } from "../src/commands/model";
import { registerPack } from "../src/commands/pack";
import { registerPatch } from "../src/commands/patch";
import { registerPublish } from "../src/commands/publish";
import { registerRun } from "../src/commands/run";
import { registerSignals } from "../src/commands/signals";
import { registerSource } from "../src/commands/source";
import { registerStatus } from "../src/commands/status";
import { registerUp } from "../src/commands/up";
import {
  readActivityBatch,
  registerWatch,
  tailActivity,
} from "../src/commands/watch";
import { registerWorkshop } from "../src/commands/workshop";
import { failureEnvelope, successEnvelope } from "../src/output";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-cli-contract-"));
  dirs.push(dir);
  const config = loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
  const store = await initStore(config);
  closers.push(() => store.close());
  return store;
}

describe("CLI JSON envelope", () => {
  it("wraps success data", () => {
    expect(successEnvelope({ runId: "r1" })).toEqual({
      ok: true,
      data: { runId: "r1" },
    });
    expect(ok(42)).toEqual({ ok: true, data: 42 });
  });

  it("classifies errors into the shared envelope shape", () => {
    const envelope = failureEnvelope(
      new CliError("not_found", "run not found", { hint: "check the id" }),
    );
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "run not found",
        hint: "check the id",
      },
    });
  });
});

describe("error code -> exit code mapping", () => {
  it("maps every contract code to its documented exit code", () => {
    expect(exitCodeForCode("usage")).toBe(2);
    expect(exitCodeForCode("not_found")).toBe(3);
    expect(exitCodeForCode("conflict")).toBe(4);
    expect(exitCodeForCode("permission")).toBe(5);
    expect(exitCodeForCode("budget")).toBe(6);
    expect(exitCodeForCode("dependency_unavailable")).toBe(7);
    expect(exitCodeForCode("internal")).toBe(8);
    expect(exitCodeForCode("needs_confirmation")).toBe(5);
    expect(CLI_ERROR_CODES.internal).toBe(8);
  });

  it("classifies structural job errors and HTTP-like statuses", () => {
    expect(
      exitCodeForError(
        Object.assign(new Error("missing"), { code: "not_found" }),
      ),
    ).toBe(3);
    expect(
      exitCodeForError(Object.assign(new Error("busy"), { status: 409 })),
    ).toBe(4);
    expect(exitCodeForError(new Error("boom"))).toBe(8);
  });

  it("covers at least 8 error classes in the table", () => {
    expect(CLI_EXIT_CODE_TABLE.length).toBeGreaterThanOrEqual(8);
    const codes = new Set(CLI_EXIT_CODE_TABLE.map((row) => row.code));
    for (const code of Object.keys(CLI_ERROR_CODES)) {
      expect(codes.has(code as keyof typeof CLI_ERROR_CODES)).toBe(true);
    }
  });

  it("keeps the docs table in sync with the code", async () => {
    const doc = await readFile(
      path.resolve(process.cwd(), "docs/cli-contract.md"),
      "utf8",
    );
    for (const row of CLI_EXIT_CODE_TABLE) {
      expect(doc).toContain(`\`${row.code}\``);
    }
    expect(doc).toContain("`needs_confirmation`");
    expect(classifyError(new CliError("budget", "x")).code).toBe("budget");
  });
});

function buildProgram(): Command {
  const program = new Command();
  registerInit(program);
  registerBootstrap(program);
  registerDoctor(program);
  registerDemo(program);
  registerPublish(program);
  registerPack(program);
  registerPatch(program);
  registerRun(program);
  registerStatus(program);
  registerModel(program);
  registerSource(program);
  registerManager(program);
  registerApprove(program);
  registerEvolve(program);
  registerDev(program);
  registerEvent(program);
  registerUp(program);
  registerJob(program);
  registerKillSwitch(program);
  registerIterate(program);
  registerSignals(program);
  registerWatch(program);
  registerWorkshop(program);
  registerAutonomy(program);
  return program;
}

function leafCommands(command: Command): Command[] {
  if (command.commands.length === 0) {
    return command.name() ? [command] : [];
  }
  return command.commands.flatMap((child) => leafCommands(child));
}

function findCommand(root: Command, ...names: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of names) {
    current = current.commands.find((child) => child.name() === name);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

describe("command registry coverage", () => {
  it("every leaf command accepts --json", () => {
    const program = buildProgram();
    const leaves = leafCommands(program);
    expect(leaves.length).toBeGreaterThanOrEqual(60);
    for (const command of leaves) {
      const hasJson = command.options.some(
        (option) => option.long === "--json",
      );
      expect(hasJson, `kit ${command.name()} is missing --json`).toBe(true);
    }
  });

  it("write commands accept --idempotency-key", () => {
    const program = buildProgram();
    const paths = [
      ["approve"],
      ["run"],
      ["iterate"],
      ["job", "start"],
      ["kill-switch", "activate"],
      ["kill-switch", "release"],
      ["autonomy", "enable"],
      ["autonomy", "rollback"],
      ["publish"],
      ["event", "emit"],
    ];
    for (const path of paths) {
      const command = findCommand(program, ...path);
      expect(command, `kit ${path.join(" ")} is not registered`).toBeDefined();
      const hasKey = command?.options.some(
        (option) => option.long === "--idempotency-key",
      );
      expect(hasKey, `kit ${path.join(" ")} is missing --idempotency-key`).toBe(
        true,
      );
    }
  });
});

describe("kit watch cursor", () => {
  it("reads ordered batches that resume without loss or duplicates", async () => {
    const store = await sqliteStore();
    const ids: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(
        await appendActivity(store, {
          runId: "run_watch",
          kind: "stage.started",
          summary: `event ${index}`,
        }),
      );
    }

    // Simulate three disconnects: each batch resumes from the last cursor.
    const seen: number[] = [];
    let cursor = 0;
    for (const limit of [2, 2, 2]) {
      const batch = await readActivityBatch(store, {
        after: cursor,
        limit,
        runId: "run_watch",
      });
      for (const event of batch.events) {
        seen.push(event.eventId);
      }
      cursor = batch.cursor;
    }

    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
    expect(cursor).toBe(ids[ids.length - 1]);
  });

  it("tailActivity --once delivers a single batch and stops", async () => {
    const store = await sqliteStore();
    await appendActivity(store, { kind: "a" });
    await appendActivity(store, { kind: "b" });
    await appendActivity(store, { kind: "c" });

    const batches: number[][] = [];
    const cursor = await tailActivity(store, {
      after: 0,
      limit: 2,
      once: true,
      onBatch: (batch) => {
        batches.push(batch.events.map((event) => event.eventId));
      },
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(cursor).toBe(2);
  });
});
