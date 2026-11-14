import { commandOnPath, runProcess, scrubbedEnv } from "../process";
import { buildCoderPrompt } from "../prompt";
import type { CoderAdapter, CoderProcessResult, CoderTask } from "../types";

interface DshEvent {
  type?: string;
  text?: string;
  sessionId?: string;
  reason?: { kind?: string };
  usage?: { totalTokens?: number };
  error?: unknown;
}

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
      },
    );
    const parsed = parseDshOutput(result.stdout);
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

export function parseDshOutput(stdout: string): {
  finalText: string;
  lastText: string;
  sessionId?: string;
  tokens?: number;
  error?: string;
  completed: boolean;
  toolCalls: number;
} {
  let finalText = "";
  let lastText = "";
  let sessionId: string | undefined;
  let tokens = 0;
  let error: string | undefined;
  let completed = false;
  let toolCalls = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: DshEvent;
    try {
      event = JSON.parse(trimmed) as DshEvent;
    } catch {
      continue;
    }
    if (event.type === "session" && event.sessionId) {
      sessionId = event.sessionId;
    }
    if (event.type === "text" && typeof event.text === "string") {
      lastText = event.text;
    }
    if (event.type === "tool_call") {
      toolCalls += 1;
    }
    if (event.type === "final") {
      finalText = typeof event.text === "string" ? event.text : finalText;
      if (event.sessionId) {
        sessionId = event.sessionId;
      }
      completed = event.reason?.kind === "completed";
    }
    if (event.type === "error") {
      error =
        typeof event.error === "string"
          ? event.error
          : JSON.stringify(event.error ?? event);
    }
    if (event.usage?.totalTokens) {
      tokens = Math.max(tokens, event.usage.totalTokens);
    }
  }

  return {
    finalText,
    lastText,
    ...(sessionId ? { sessionId } : {}),
    ...(tokens ? { tokens } : {}),
    ...(error ? { error } : {}),
    completed,
    toolCalls,
  };
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
  };
}
