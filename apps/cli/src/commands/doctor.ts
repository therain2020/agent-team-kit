import { collectPreflight } from "@kit/bootstrap";
import type { Command } from "commander";
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
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printPreflight(report);
        console.log("\nDocs: docs/install.md");
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
}
