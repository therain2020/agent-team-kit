import type { CoderStreamEvent, CoderTurn } from "./types";

interface DshEvent {
  type?: string;
  text?: string;
  sessionId?: string;
  reason?: { kind?: string };
  usage?: { totalTokens?: number };
  error?: unknown;
  phase?: string;
  turn?: number;
  step?: number;
  tool?: string;
  callId?: string;
  input?: unknown;
  status?: string;
  result?: unknown;
}

export interface ParsedDshOutput {
  finalText: string;
  lastText: string;
  sessionId?: string;
  tokens?: number;
  error?: string;
  completed: boolean;
  toolCalls: number;
  turns: CoderTurn[];
  events: CoderStreamEvent[];
  observabilityError?: string;
}

export interface DshStreamParserOptions {
  onEvent?: (event: CoderStreamEvent) => void | Promise<void>;
  now?: () => Date;
}

const SECRET_KEY =
  /(api[_-]?key|access[_-]?key|client[_-]?secret|secret|password|authorization|cookie|private[_-]?key|^token$)/i;

export class DshStreamParser {
  private buffer = "";
  private pending: Promise<void>[] = [];
  private turns: CoderTurn[] = [];
  private events: CoderStreamEvent[] = [];
  private currentTurn?: CoderTurn;
  private currentTurnNumber = 0;
  private currentStep = 0;
  private sessionId?: string;
  private tokens = 0;
  private toolCalls = 0;
  private finalText = "";
  private lastText = "";
  private error?: string;
  private completed = false;
  private closed = false;
  private observabilityError?: string;
  private readonly now: () => Date;

  constructor(private readonly options: DshStreamParserOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  push(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  finishSync(): ParsedDshOutput {
    this.close("completed");
    return this.snapshot();
  }

  async finish(): Promise<ParsedDshOutput> {
    this.close("completed");
    await Promise.all(this.pending);
    return this.snapshot();
  }

  private close(status: "completed" | "failed"): void {
    if (this.closed) {
      return;
    }
    const trailing = this.buffer.trim();
    if (trailing) {
      this.handleLine(trailing);
    }
    this.buffer = "";
    this.closed = true;
    this.finishTurn(status);
  }

  private handleLine(line: string): void {
    if (!line.startsWith("{")) {
      return;
    }
    let event: DshEvent;
    try {
      event = JSON.parse(line) as DshEvent;
    } catch {
      return;
    }
    this.handleEvent(event);
  }

  private handleEvent(event: DshEvent): void {
    const at = this.now().toISOString();
    if (event.type === "session" && event.sessionId) {
      this.sessionId = event.sessionId;
      this.emit("session", at, { payload: { sessionId: event.sessionId } });
      return;
    }
    if (event.type === "status") {
      if (event.phase === "turn_start") {
        this.finishTurn("completed");
        this.currentTurnNumber = event.turn ?? this.currentTurnNumber + 1;
        this.currentStep = 0;
        this.currentTurn = {
          turn: this.currentTurnNumber,
          startedAt: at,
          steps: 0,
          toolCalls: 0,
          tokens: 0,
          summary: "",
          events: [],
        };
        this.turns.push(this.currentTurn);
        this.emit("turn_start", at, {
          turn: this.currentTurnNumber,
          status: "running",
        });
        return;
      }
      if (event.phase === "step_start") {
        this.ensureTurn(at);
        const turn = this.currentTurn;
        if (!turn) {
          return;
        }
        this.currentStep = event.step ?? this.currentStep + 1;
        turn.steps = Math.max(turn.steps, this.currentStep);
        this.emit("step_start", at, {
          step: this.currentStep,
          status: "running",
        });
        return;
      }
      if (event.phase === "step_end") {
        this.ensureTurn(at);
        const turn = this.currentTurn;
        if (!turn) {
          return;
        }
        const total = event.usage?.totalTokens;
        if (typeof total === "number") {
          this.tokens = Math.max(this.tokens, total);
          turn.tokens = this.tokens;
        }
        this.emit("step_end", at, {
          step: this.currentStep,
          tokens: this.tokens,
          status: "completed",
        });
        return;
      }
    }
    if (event.type === "thinking" && typeof event.text === "string") {
      this.ensureTurn(at);
      this.emit("thinking", at, {
        summary: truncate(event.text, 300),
        payload: { text: truncate(event.text, 8_000) },
      });
      return;
    }
    if (event.type === "text" && typeof event.text === "string") {
      this.ensureTurn(at);
      this.lastText = event.text;
      if (this.currentTurn) {
        this.currentTurn.summary = truncate(event.text, 500);
      }
      this.emit("text", at, {
        summary: truncate(event.text, 300),
        payload: { text: truncate(event.text, 8_000) },
      });
      return;
    }
    if (event.type === "tool_call") {
      this.ensureTurn(at);
      this.toolCalls += 1;
      if (this.currentTurn) {
        this.currentTurn.toolCalls += 1;
      }
      this.emit("tool_call", at, {
        tool: event.tool,
        callId: event.callId,
        status: "running",
        summary: truncate(
          `${event.tool ?? "tool"}: ${inputSummary(event.input)}`,
          300,
        ),
        payload: { input: redact(event.input) },
      });
      return;
    }
    if (event.type === "tool_result") {
      this.ensureTurn(at);
      this.emit("tool_result", at, {
        callId: event.callId,
        status: event.status ?? "completed",
        summary: truncate(resultSummary(event.result), 2_000),
        payload: { result: redact(event.result) },
      });
      return;
    }
    if (event.type === "final") {
      this.finalText = typeof event.text === "string" ? event.text : "";
      this.completed = event.reason?.kind === "completed";
      if (event.sessionId) {
        this.sessionId = event.sessionId;
      }
      this.emit("final", at, {
        status: this.completed ? "completed" : "failed",
        summary: truncate(this.finalText || this.lastText, 500),
        payload: { text: truncate(this.finalText, 8_000) },
      });
      this.finishTurn(this.completed ? "completed" : "failed");
      return;
    }
    if (event.type === "error") {
      this.error =
        typeof event.error === "string"
          ? event.error
          : JSON.stringify(event.error ?? event);
      this.emit("error", at, {
        status: "failed",
        summary: truncate(this.error, 500),
        payload: { error: truncate(this.error, 8_000) },
      });
      this.finishTurn("failed");
    }
  }

  private ensureTurn(at: string): void {
    if (this.currentTurn) {
      return;
    }
    this.currentTurnNumber = Math.max(1, this.currentTurnNumber);
    this.currentTurn = {
      turn: this.currentTurnNumber,
      startedAt: at,
      steps: 0,
      toolCalls: 0,
      tokens: this.tokens,
      summary: "",
      events: [],
    };
    this.turns.push(this.currentTurn);
  }

  private finishTurn(status: "completed" | "failed"): void {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }
    if (status === "completed" && this.completed) {
      turn.summary = truncate(
        this.finalText || this.lastText || turn.summary,
        500,
      );
    }
    turn.finishedAt = this.now().toISOString();
    this.emit("turn_end", turn.finishedAt, {
      turn: turn.turn,
      status,
      summary: turn.summary,
      tokens: turn.tokens,
    });
    this.currentTurn = undefined;
  }

  private emit(
    kind: CoderStreamEvent["kind"],
    at: string,
    extra: Omit<CoderStreamEvent, "kind" | "at"> = {},
  ): void {
    const event: CoderStreamEvent = {
      kind,
      at,
      ...(this.currentTurn ? { turn: this.currentTurn.turn } : {}),
      ...(this.currentStep > 0 ? { step: this.currentStep } : {}),
      ...extra,
    };
    this.events.push(event);
    if (this.currentTurn) {
      this.currentTurn.events.push(event);
    }
    const callback = this.options.onEvent;
    if (!callback) {
      return;
    }
    try {
      const result = callback(event);
      if (result) {
        this.pending.push(
          Promise.resolve(result).catch((error: unknown) => {
            this.observabilityError = String(error);
          }),
        );
      }
    } catch (error) {
      this.observabilityError = String(error);
    }
  }

  private snapshot(): ParsedDshOutput {
    return {
      finalText: this.finalText,
      lastText: this.lastText,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.tokens ? { tokens: this.tokens } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.observabilityError
        ? { observabilityError: this.observabilityError }
        : {}),
      completed: this.completed,
      toolCalls: this.toolCalls,
      turns: this.turns,
      events: this.events,
    };
  }
}

export function parseDshOutput(
  stdout: string,
): Omit<ParsedDshOutput, "turns" | "events"> & { turns: CoderTurn[] } {
  const parser = new DshStreamParser();
  parser.push(stdout);
  return parser.finishSync();
}

function inputSummary(input: unknown): string {
  if (typeof input === "string") {
    return truncate(input, 200);
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of [
      "command",
      "file_path",
      "path",
      "pattern",
      "query",
      "url",
      "description",
    ]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return truncate(value, 200);
      }
    }
  }
  return truncate(JSON.stringify(redact(input)) ?? "{}", 200);
}

function resultSummary(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(redact(result));
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[depth]";
  }
  if (typeof value === "string") {
    return truncate(value, 8_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = SECRET_KEY.test(key)
        ? "[redacted]"
        : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}
