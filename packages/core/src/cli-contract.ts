/**
 * Machine-readable CLI contract (plan 91 §3.6).
 *
 * The CLI's first-class caller is an agent, not a human. Every command that
 * supports `--json` emits one of:
 *
 *   { "ok": true,  "data": <payload> }
 *   { "ok": false, "error": { "code": <CliErrorCode>, "message": "...", "hint": "..." } }
 *
 * Failures are classified into a stable error-code enum whose values map to
 * process exit codes. Commands must never call `process.exit(n)` directly with
 * an ad-hoc number; they raise a `CliError` (or let one be classified) and the
 * CLI maps it through `exitCodeForCode`.
 */

/** Stable exit codes. Keep this table in sync with docs/cli-contract.md. */
export const CLI_EXIT_CODES = {
  ok: 0,
  usage: 2,
  not_found: 3,
  conflict: 4,
  permission: 5,
  budget: 6,
  dependency_unavailable: 7,
  internal: 8,
} as const;

/**
 * Stable error codes. `needs_confirmation` covers the non-interactive rule:
 * a command that would prompt on a TTY instead fails with this code when no
 * explicit `--yes` (or equivalent) flag was supplied. It shares the permission
 * exit code because it means "you may not proceed without consent".
 */
export const CLI_ERROR_CODES = {
  usage: 2,
  not_found: 3,
  conflict: 4,
  permission: 5,
  budget: 6,
  dependency_unavailable: 7,
  internal: 8,
  needs_confirmation: 5,
} as const;

export type CliExitCodeName = keyof typeof CLI_EXIT_CODES;
export type CliErrorCode = keyof typeof CLI_ERROR_CODES;

export interface CliErrorPayload {
  code: CliErrorCode;
  message: string;
  hint?: string;
  details?: unknown;
}

export type CliEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: CliErrorPayload };

export const EXIT_OK = 0;

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(
    code: CliErrorCode,
    message: string,
    options: { hint?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): CliErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

export function exitCodeForCode(code: CliErrorCode): number {
  return CLI_ERROR_CODES[code];
}

export function ok<T>(data: T): CliEnvelope<T> {
  return { ok: true, data };
}

export function fail(error: CliErrorPayload): CliEnvelope<never> {
  return { ok: false, error };
}

/**
 * Minimal structural view of `JobError` and HTTP-style errors. We avoid
 * importing `@kit/job` from core to keep the dependency direction clean.
 */
interface StatusBearingError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const JOB_ERROR_CODES: Record<string, CliErrorCode> = {
  not_found: "not_found",
  job_not_found: "not_found",
  run_not_found: "not_found",
  conflict: "conflict",
  invalid_state: "conflict",
  state_conflict: "conflict",
  not_paused: "conflict",
  validation: "usage",
  invalid_input: "usage",
  bad_request: "usage",
  permission: "permission",
  forbidden: "permission",
  budget_exhausted: "budget",
  budget: "budget",
  dependency_unavailable: "dependency_unavailable",
  unavailable: "dependency_unavailable",
};

/**
 * Classify an arbitrary thrown value into a CliError. Known error classes keep
 * their meaning; everything else becomes `internal` so agents can still branch
 * on "the CLI broke" vs. "my input was wrong".
 */
export function classifyError(error: unknown): CliError {
  if (isCliError(error)) {
    return error;
  }

  if (error && typeof error === "object") {
    const candidate = error as StatusBearingError;
    const message =
      typeof candidate.message === "string" ? candidate.message : String(error);
    if (typeof candidate.code === "string") {
      const mapped = JOB_ERROR_CODES[candidate.code];
      if (mapped) {
        return new CliError(mapped, message, { cause: error });
      }
    }
    if (typeof candidate.status === "number") {
      const mapped = exitStatusToCode(candidate.status);
      if (mapped) {
        return new CliError(mapped, message, { cause: error });
      }
    }
  }

  return new CliError(
    "internal",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function exitStatusToCode(status: number): CliErrorCode | null {
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 401 || status === 403) {
    return "permission";
  }
  if (status === 429) {
    return "budget";
  }
  if (status === 503) {
    return "dependency_unavailable";
  }
  if (status >= 400 && status < 500) {
    return "usage";
  }
  return null;
}

export function exitCodeForError(error: unknown): number {
  return exitCodeForCode(classifyError(error).code);
}

/** Human-readable exit-code table used by docs and tests. */
export const CLI_EXIT_CODE_TABLE: ReadonlyArray<{
  code: CliErrorCode;
  exitCode: number;
  description: string;
}> = [
  { code: "usage", exitCode: 2, description: "Argument or input is invalid" },
  {
    code: "not_found",
    exitCode: 3,
    description: "Referenced object does not exist",
  },
  {
    code: "conflict",
    exitCode: 4,
    description: "State conflict or version mismatch",
  },
  { code: "permission", exitCode: 5, description: "Permission denied" },
  { code: "budget", exitCode: 6, description: "Budget or quota exhausted" },
  {
    code: "dependency_unavailable",
    exitCode: 7,
    description: "A required dependency is unavailable",
  },
  { code: "internal", exitCode: 8, description: "Unexpected internal error" },
  {
    code: "needs_confirmation",
    exitCode: 5,
    description: "Explicit confirmation required (non-interactive)",
  },
];
