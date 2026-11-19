import { collectPreflight } from "@kit/bootstrap";
import { exitCodeForCode } from "@kit/core";
import type { Command } from "commander";
import { emit } from "../output";
import { printPreflight } from "../preflight-output";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check the toolchain, services, model key and coder CLIs (same checks as kit bootstrap)",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const report = await collectPreflight({ probe: true });
      emit(options.json, report, () => {
        printPreflight(report);
        console.log("\nDocs: docs/install.md");
      });
      if (!report.ok) {
        process.exitCode = exitCodeForCode("dependency_unavailable");
      }
    });
}
