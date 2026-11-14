/**
 * External boundaries (Temporal payloads, model output, catch blocks) may hand
 * us anything. SQL parameters and API responses must receive plain strings,
 * otherwise postgres.js fails with "Received an instance of Object" and the
 * failure path itself crashes.
 */
export function toErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function asText(value: unknown, fallback = ""): string {
  return value === undefined || value === null
    ? fallback
    : toErrorMessage(value);
}
