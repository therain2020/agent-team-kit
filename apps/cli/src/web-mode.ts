export type WebMode = "production" | "dev";

/**
 * Normalize a web mode value. Unknown values fall back to the dev server so
 * an explicit opt-in is required to run a non-production experiment.
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

/** Production is the default: the console is unusably slow under next dev. */
export function resolveWebMode(
  value: string | undefined = process.env.KIT_WEB_MODE,
): WebMode {
  if (!value || value.trim() === "") {
    return "production";
  }
  return parseWebMode(value) ?? "dev";
}

/** Arguments for `bun run --cwd apps/web <script>` under the supervisor. */
export function webRunArgs(mode: WebMode): string[] {
  return ["run", "--cwd", "apps/web", mode === "production" ? "start" : "dev"];
}
