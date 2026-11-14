import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";

export function registerEvent(program: Command): void {
  const event = program
    .command("event")
    .description("Event gateway operations");

  event
    .command("emit")
    .description("Sign and POST a generic event to the gateway")
    .requiredOption("--type <type>", "canonical event type")
    .option("--payload <json>", "payload JSON", "{}")
    .option("--payload-file <path>", "read payload from a file")
    .option(
      "--url <url>",
      "gateway ingest URL",
      process.env.KIT_GATEWAY_URL ?? "http://127.0.0.1:8787/ingest/generic",
    )
    .option(
      "--secret-env <name>",
      "environment variable holding the HMAC secret",
      "KIT_EVENT_SECRET",
    )
    .action(
      async (options: {
        type: string;
        payload: string;
        payloadFile?: string;
        url: string;
        secretEnv: string;
      }) => {
        const secret = process.env[options.secretEnv];
        if (!secret) {
          console.error(`✖ ${options.secretEnv} is not set`);
          process.exitCode = 1;
          return;
        }

        let payload: unknown;
        try {
          const raw = options.payloadFile
            ? await readFile(options.payloadFile, "utf8")
            : options.payload;
          const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
          payload = JSON.parse(clean);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ invalid payload: ${message}`);
          process.exitCode = 1;
          return;
        }

        const body = JSON.stringify({
          type: options.type,
          payload,
          occurredAt: new Date().toISOString(),
          idempotencyKey: `cli:${options.type}:${Date.now()}`,
        });
        const signature = `sha256=${createHmac("sha256", secret)
          .update(body)
          .digest("hex")}`;

        try {
          const response = await fetch(options.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-kit-signature": signature,
              "x-kit-timestamp": Date.now().toString(),
            },
            body,
          });
          const text = await response.text();
          console.log(`${response.status} ${text}`);
          if (!response.ok) {
            process.exitCode = 1;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`✖ gateway unreachable: ${message}`);
          process.exitCode = 1;
        }
      },
    );
}
