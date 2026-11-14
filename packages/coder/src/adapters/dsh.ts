import { DshStreamParser } from "../dsh-stream";
import { commandOnPath, runProcess, scrubbedEnv } from "../process";
import { buildCoderPrompt } from "../prompt";
import type { CoderAdapter, CoderProcessResult, CoderTask } from "../types";

export { parseDshOutput } from "../dsh-stream";

export class DshCoderAdapter implements CoderAdapter {
  readonly id = "dsh" as const;

  async available(): Promise<boolean> {
    return commandOnPath("dsh") !== null;
  }

  async run(task: CoderTask): Promise<CoderProcessResult> {
    const command = commandOnPath("dsh");
    if (!command) {
      return failure("dsh not found on PATH");
    }

    const prompt = buildCoderPrompt(task);
    const startedAt = Date.now();
    const parser = new DshStreamParser({ onEvent: task.onEvent });
    const result = await runProcess(
      command,
      [
        "--profile",
        "headless",
        "--json",
        "--permission-mode",
        "workspace-write",
        "--approval-policy",
        "never",
        "-",
      ],
      {
        cwd: task.sandboxRoot,
        env: scrubbedEnv(task.envAllowlist),
        input: prompt,
        timeoutMs: task.timeoutMs ?? 25 * 60 * 1000,
        onStdout: (chunk) => parser.push(chunk),
      },
    );
    const parsed = await parser.finish();
    const durationMs = Date.now() - startedAt;
    const ok =
      !result.timedOut &&
      !result.error &&
      !parsed.error &&
      result.exitCode === 0 &&
      (parsed.completed || Boolean(parsed.finalText || parsed.lastText));

    return {
      coder: "dsh",
      ok,
      exitCode: result.exitCode,
      summary:
        parsed.finalText ||
        parsed.lastText ||
        (ok ? "dsh completed without a summary" : "dsh produced no output"),
      transcript: [
        result.stdout.trim(),
        result.stderr.trim() ? `--- stderr ---\n${result.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      durationMs,
      ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      turns: parsed.turns,
      ...(parsed.error
        ? { error: parsed.error }
        : result.error
          ? { error: result.error }
          : result.timedOut
            ? { error: "dsh timed out" }
            : result.exitCode !== 0
              ? { error: `dsh exited ${result.exitCode}` }
              : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  }
}

function failure(message: string): CoderProcessResult {
  return {
    coder: "dsh",
    ok: false,
    exitCode: null,
    summary: message,
    transcript: "",
    durationMs: 0,
    error: message,
    turns: [],
  };
}
