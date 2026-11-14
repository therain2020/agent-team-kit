import { commandOnPath, runProcess, scrubbedEnv } from "../process";
import { buildCoderPrompt } from "../prompt";
import type {
  CoderAdapter,
  CoderAvailability,
  CoderId,
  CoderProcessResult,
  CoderTask,
} from "../types";
import { DshCoderAdapter } from "./dsh";

export class CommandCoderAdapter implements CoderAdapter {
  constructor(
    readonly id: CoderId,
    private readonly spec: {
      command: string;
      args: string[];
      promptMode: "stdin" | "arg";
    },
  ) {}

  async available(): Promise<boolean> {
    return (
      Boolean(this.spec.command) && commandOnPath(this.spec.command) !== null
    );
  }

  async run(task: CoderTask): Promise<CoderProcessResult> {
    if (!this.spec.command) {
      return failure(this.id, "coder command is not configured");
    }
    const resolved = commandOnPath(this.spec.command);
    if (!resolved) {
      return failure(this.id, `${this.spec.command} not found on PATH`);
    }

    const prompt = buildCoderPrompt(task);
    const args = this.spec.args.map((arg) =>
      arg.replaceAll("{prompt}", prompt).replaceAll("{cwd}", task.sandboxRoot),
    );

    const startedAt = Date.now();
    const result = await runProcess(resolved, args, {
      cwd: task.sandboxRoot,
      env: scrubbedEnv(task.envAllowlist),
      input: this.spec.promptMode === "stdin" ? prompt : undefined,
      timeoutMs: task.timeoutMs ?? 25 * 60 * 1000,
    });
    const durationMs = Date.now() - startedAt;
    const ok = !result.timedOut && !result.error && result.exitCode === 0;
    const summary = (result.stdout || result.stderr).trim().slice(-4000);

    return {
      coder: this.id,
      ok,
      exitCode: result.exitCode,
      summary: summary || (ok ? `${this.id} completed` : `${this.id} failed`),
      transcript: [
        result.stdout.trim(),
        result.stderr.trim() ? `--- stderr ---\n${result.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      durationMs,
      ...(result.error
        ? { error: result.error }
        : result.timedOut
          ? { error: `${this.id} timed out` }
          : result.exitCode !== 0
            ? { error: `${this.id} exited ${result.exitCode}` }
            : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  }
}

export function createCoderAdapter(
  id: CoderId,
  env: NodeJS.ProcessEnv = process.env,
): CoderAdapter {
  if (id === "dsh") {
    return new DshCoderAdapter();
  }
  const configured =
    id === "codex"
      ? (env.KIT_CODER_CODEX_CMD ?? "codex exec --full-auto -")
      : id === "opencode"
        ? (env.KIT_CODER_OPENCODE_CMD ?? "opencode run -")
        : (env.KIT_CODER_COMMAND ?? "");
  const tokens = splitCommand(configured);
  const command = tokens[0] ?? "";
  const args = tokens.slice(1);
  return new CommandCoderAdapter(id, {
    command,
    args,
    promptMode: args.some((arg) => arg.includes("{prompt}")) ? "arg" : "stdin",
  });
}

export async function detectCoders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CoderAvailability[]> {
  const ids: CoderId[] = ["dsh", "codex", "opencode", "command"];
  const results: CoderAvailability[] = [];
  for (const id of ids) {
    const adapter = createCoderAdapter(id, env);
    const available = await adapter.available();
    results.push({
      id,
      available,
      ...(id === "dsh"
        ? { command: commandOnPath("dsh") ?? undefined }
        : id === "codex"
          ? { command: firstToken(env.KIT_CODER_CODEX_CMD ?? "codex") }
          : id === "opencode"
            ? { command: firstToken(env.KIT_CODER_OPENCODE_CMD ?? "opencode") }
            : { command: firstToken(env.KIT_CODER_COMMAND ?? "") }),
    });
  }
  return results;
}

function splitCommand(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(value);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = pattern.exec(value);
  }
  return tokens;
}

function firstToken(value: string): string | undefined {
  return splitCommand(value)[0];
}

function failure(id: CoderId, message: string): CoderProcessResult {
  return {
    coder: id,
    ok: false,
    exitCode: null,
    summary: message,
    transcript: "",
    durationMs: 0,
    error: message,
  };
}
