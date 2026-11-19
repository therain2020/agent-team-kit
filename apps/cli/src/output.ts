import {
  type CliEnvelope,
  type CliError,
  classifyError,
  exitCodeForCode,
} from "@kit/core";

/**
 * Shared plumbing for the machine-readable CLI contract (plan 91 §3.6).
 *
 * Human output stays exactly as it was when `--json` is absent: `emitJson`
 * delegates to a caller-supplied renderer. Failures always set `process.exitCode`
 * through the shared error-code table, never an ad-hoc number.
 */

export interface JsonOptions {
  json?: boolean;
}

export function wantsJson(
  options: JsonOptions | undefined | Record<string, unknown>,
): boolean {
  return options?.json === true;
}

export function successEnvelope<T>(data: T): CliEnvelope<T> {
  return { ok: true, data };
}

export function failureEnvelope(error: unknown): CliEnvelope<never> {
  return { ok: false, error: classifyError(error).toJSON() };
}

/** Print the JSON success envelope. */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(successEnvelope(data), null, 2));
}

/** Print a single NDJSON line for streaming commands such as `kit watch`. */
export function printJsonLine(data: unknown): void {
  console.log(JSON.stringify(successEnvelope(data)));
}

/**
 * Emit the result of a command: machine envelope in JSON mode, unchanged
 * human rendering otherwise.
 */
export function emit<T>(
  json: boolean,
  data: T,
  human: () => void = () => undefined,
): void {
  if (json) {
    printJson(data);
    return;
  }
  human();
}

/**
 * Report a failure. In JSON mode the error envelope goes to stdout so agents
 * can parse a single stream; otherwise the human message goes to stderr.
 * Always updates `process.exitCode` from the classified error.
 */
export function emitError(
  json: boolean,
  error: unknown,
  renderHuman?: (error: CliError) => void,
): void {
  const classified = classifyError(error);
  process.exitCode = exitCodeForCode(classified.code);
  if (json) {
    console.log(
      JSON.stringify({ ok: false, error: classified.toJSON() }, null, 2),
    );
    return;
  }
  if (renderHuman) {
    renderHuman(classified);
    return;
  }
  console.error(`✖ ${classified.message}`);
  if (classified.hint) {
    console.error(`  ${classified.hint}`);
  }
}
