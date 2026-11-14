import { createModelGateway } from "@kit/model";
import type { Command } from "commander";

export function registerModel(program: Command): void {
  const model = program.command("model").description("Model gateway");

  model
    .command("check")
    .description("Send a probe through the configured model gateway")
    .option("--alias <alias>", "model alias", "deepseek-flash")
    .option("--prompt <text>", "probe prompt", "ping")
    .action(async (options: { alias: string; prompt: string }) => {
      const gateway = createModelGateway();

      try {
        const response = await gateway.complete({
          model: options.alias,
          instructions: "Reply with one short sentence.",
          input: options.prompt,
        });
        console.log(
          JSON.stringify({ alias: options.alias, response }, null, 2),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✖ model check failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
