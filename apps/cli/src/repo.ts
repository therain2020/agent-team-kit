import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function findRepoRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  while (true) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
        };
        if (parsed.name === "agent-team-kit") {
          return dir;
        }
      } catch {
        // Ignore malformed package.json and keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function kitCommand(start = process.cwd()): string {
  return findRepoRoot(start) ? "bun run kit" : "kit";
}
