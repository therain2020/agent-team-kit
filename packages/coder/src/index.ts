import { createCoderAdapter, detectCoders } from "./adapters/cli";
import { createSandbox } from "./sandbox";
import type { CoderId, CoderResult, CoderTask, SandboxMode } from "./types";

export * from "./types";
export { buildCoderPrompt } from "./prompt";
export { createSandbox } from "./sandbox";
export {
  createCoderAdapter,
  detectCoders,
  CommandCoderAdapter,
} from "./adapters/cli";
export { DshCoderAdapter, parseDshOutput } from "./adapters/dsh";
export { commandOnPath, runProcess } from "./process";
export {
  coderSandboxBase,
  coderSandboxRoot,
  isCoderSandboxPath,
} from "./paths";

export interface RunCoderTaskInput extends CoderTask {
  coder: CoderId;
  sandboxMode?: SandboxMode;
  installDeps?: boolean;
  keepSandbox?: boolean;
}

export async function runCoderTask(
  input: RunCoderTaskInput,
): Promise<CoderResult> {
  const adapter = createCoderAdapter(input.coder);
  if (!(await adapter.available())) {
    throw new Error(`coder ${input.coder} is not available on PATH`);
  }

  const sandbox = await createSandbox({
    repoRoot: input.repoRoot,
    sandboxRoot: input.sandboxRoot,
    mode: input.sandboxMode ?? "snapshot",
    installDeps: input.installDeps,
    keep: input.keepSandbox,
  });

  try {
    const result = await adapter.run({
      ...input,
      sandboxRoot: sandbox.dir,
    });
    const changes = await sandbox.collect();
    return {
      ...result,
      changedFiles: changes.changedFiles,
      diff: changes.diff,
      sandbox: {
        mode: sandbox.mode,
        baselineSha: sandbox.baselineSha,
        setupLog: sandbox.setupLog,
      },
    };
  } catch (error) {
    return {
      coder: input.coder,
      ok: false,
      exitCode: null,
      summary: error instanceof Error ? error.message : String(error),
      transcript: "",
      durationMs: 0,
      changedFiles: [],
      diff: "",
      error: error instanceof Error ? error.message : String(error),
      sandbox: {
        mode: sandbox.mode,
        baselineSha: sandbox.baselineSha,
        setupLog: sandbox.setupLog,
      },
    };
  } finally {
    await sandbox.cleanup();
  }
}
