import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "@kit/core";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerDev(program: Command): void {
  program
    .command("dev <action>")
    .description("Manage the local stack (up|down)")
    .option("--json", "machine-readable output", false)
    .action((action: string, options: { json?: boolean }) => {
      const json = wantsJson(options);
      if (action !== "up" && action !== "down") {
        emitError(json, new CliError("usage", "action must be 'up' or 'down'"));
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

      const proc = spawnSync("docker", args, {
        stdio: json ? "ignore" : "inherit",
      });

      if (proc.status === 0) {
        emit(json, { action, exitCode: 0 }, () => undefined);
        return;
      }
      emitError(
        json,
        new CliError(
          "dependency_unavailable",
          `docker compose ${action} failed (exit ${proc.status ?? "unknown"})`,
          { hint: "is Docker installed and running?" },
        ),
        () => {
          console.error(`✖ docker compose ${action} failed`);
        },
      );
      if (!json) {
        // Preserve docker's own exit status for humans.
        process.exitCode = proc.status ?? 1;
      }
    });
}
