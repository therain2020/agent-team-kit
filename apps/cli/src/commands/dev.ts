import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

export function registerDev(program: Command): void {
  program
    .command("dev <action>")
    .description("Manage the local stack (up|down)")
    .action((action: string) => {
      if (action !== "up" && action !== "down") {
        console.error("✖ action must be 'up' or 'down'");
        process.exitCode = 1;
        return;
      }

      const composePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../deploy/docker-compose.yml",
      );
      const args =
        action === "up"
          ? ["compose", "-f", composePath, "up", "-d"]
          : ["compose", "-f", composePath, "down"];

      const proc = spawnSync("docker", args, { stdio: "inherit" });

      process.exit(proc.status ?? 1);
    });
}
