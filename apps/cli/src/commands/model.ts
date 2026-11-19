import { CliError } from "@kit/core";
import { createModelGateway } from "@kit/model";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerModel(program: Command): void {
  const model = program.command("model").description("Model gateway");

  model
    .command("check")
    .description("Send a probe through the configured model gateway")
    .option("--alias <alias>", "model alias", "deepseek-flash")
    .option("--prompt <text>", "probe prompt", "ping")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { alias: string; prompt: string; json: boolean }) => {
        const json = wantsJson(options);
        const gateway = createModelGateway();

        try {
          const response = await gateway.complete({
            model: options.alias,
            instructions: "Reply with one short sentence.",
            input: options.prompt,
          });
          emit(json, { alias: options.alias, response }, () => {
            console.log(
              JSON.stringify({ alias: options.alias, response }, null, 2),
            );
          });
        } catch (error) {
          emitError(
            json,
            new CliError(
              "dependency_unavailable",
              `model check failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      },
    );
}
