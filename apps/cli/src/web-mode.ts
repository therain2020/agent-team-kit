export type WebMode = "production" | "dev";

/**
 * Normalize a web mode value. Anything that is not explicitly "production"
 * keeps the long-standing dev server path as the safe fallback.
 */
export function parseWebMode(value: string | undefined): WebMode | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "production") {
    return "production";
  }
  if (normalized === "dev" || normalized === "development") {
    return "dev";
  }
  return null;
}

export function resolveWebMode(
  value: string | undefined = process.env.KIT_WEB_MODE,
): WebMode {
  return parseWebMode(value) ?? "dev";
}

/** Arguments for `bun run --cwd apps/web <script>` under the supervisor. */
export function webRunArgs(mode: WebMode): string[] {
  return ["run", "--cwd", "apps/web", mode === "production" ? "start" : "dev"];
}
