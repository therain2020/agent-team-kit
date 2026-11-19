import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "@kit/core";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface WorkspaceWrite {
  path: string;
  content: string;
}

export function registerPatch(program: Command): void {
  const patch = program.command("patch").description("Sandbox patch proposals");

  patch
    .command("list <runId>")
    .description("List files a run wrote into its sandbox")
    .option("--json", "machine-readable output", false)
    .action(async (runId: string, options: { json?: boolean }) => {
      const json = wantsJson(options);
      const writes = await loadWrites(runId);
      const files = [...writes.entries()].map(([file, content]) => ({
        path: file,
        chars: content.length,
      }));
      emit(json, { runId, files }, () => {
        if (writes.size === 0) {
          console.log("No workspace_write tool calls in this run.");
          return;
        }
        for (const [file, content] of writes) {
          console.log(`${file}  (${content.length} chars)`);
        }
        console.log(`\nApply with: bun run kit patch apply ${runId} --apply`);
      });
    });

  patch
    .command("apply <runId>")
    .description("Apply a run's sandbox patch to the repository (backup first)")
    .option("--apply", "write the changes (default is dry-run)", false)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        runId: string,
        options: {
          apply: boolean;
          idempotencyKey?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        console.warn(
          "[deprecated] `kit patch` handles workspace_write sandbox patches; iteration pending changes use `kit job changes` + `kit job apply`.",
        );
        const writes = await loadWrites(runId);
        if (writes.size === 0) {
          emitError(
            json,
            new CliError(
              "not_found",
              "no workspace_write tool calls in this run",
            ),
          );
          return;
        }
        const repoRoot = path.resolve(process.cwd());
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupRoot = path.join(repoRoot, ".backup", stamp);
        const files: string[] = [];
        for (const [relative, content] of writes) {
          const target = safeTarget(repoRoot, relative);
          if (!target) {
            emitError(
              json,
              new CliError("usage", `refusing unsafe path: ${relative}`),
            );
            return;
          }
          files.push(relative);
          if (!options.apply) {
            continue;
          }
          if (existsSync(target)) {
            const backup = path.join(backupRoot, relative);
            await mkdir(path.dirname(backup), { recursive: true });
            await writeFile(backup, await readFile(target));
          }
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
        }
        const data = {
          runId,
          applied: options.apply,
          backup: options.apply ? backupRoot : undefined,
          files,
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        };
        emit(json, data, () => {
          console.log(JSON.stringify(data, null, 2));
          if (!options.apply) {
            console.log("\nDry run. Re-run with --apply to write.");
          }
        });
      },
    );
}

async function loadWrites(runId: string): Promise<Map<string, string>> {
  const store = await initStore();
  try {
    const artifacts = await store.artifactStore.listByRun(runId);
    const writes = new Map<string, { createdAt: string; content: string }>();
    for (const artifact of artifacts) {
      const manifest = await store.manifests.get(artifact.manifestId);
      if (!manifest?.stageId.includes(":tool:")) {
        continue;
      }
      const blob = await store.blobs.findById(artifact.blobId);
      if (!blob) {
        continue;
      }
      let parsed: {
        tool?: unknown;
        arguments?: Record<string, unknown>;
      };
      try {
        parsed = JSON.parse(
          new TextDecoder().decode(await store.blobClient.get(blob.storageKey)),
        ) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.tool !== "workspace_write") {
        continue;
      }
      const targetPath = parsed.arguments?.path;
      const content = parsed.arguments?.content;
      if (typeof targetPath !== "string" || typeof content !== "string") {
        continue;
      }
      const existing = writes.get(targetPath);
      if (!existing || artifact.createdAt > existing.createdAt) {
        writes.set(targetPath, { createdAt: artifact.createdAt, content });
      }
    }
    return new Map(
      [...writes.entries()].map(([file, value]) => [file, value.content]),
    );
  } finally {
    await store.close();
  }
}

function safeTarget(repoRoot: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized
      .split("/")
      .some((part) =>
        [".git", "node_modules", ".env", ".tmp", "variants"].includes(part),
      )
  ) {
    return null;
  }
  const target = path.resolve(repoRoot, normalized);
  return target.startsWith(`${repoRoot}${path.sep}`) ? target : null;
}
