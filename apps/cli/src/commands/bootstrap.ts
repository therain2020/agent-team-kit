import {
  loadApiKey,
  probeModel,
  readBootstrapProfileSync,
  saveApiKey,
  writeBootstrapProfile,
} from "@kit/bootstrap";
import type { Command } from "commander";

interface BootstrapOptions {
  key?: string;
  baseUrl?: string;
  flash?: string;
  pro?: string;
  workspace?: string;
  status?: boolean;
  probe?: boolean;
  json?: boolean;
}

export function registerBootstrap(program: Command): void {
  program
    .command("bootstrap")
    .description("Configure the kit from a single model API key")
    .option("--key <key>", "model API key (prefer the web /welcome form)")
    .option("--base-url <url>", "OpenAI-compatible base URL")
    .option("--flash <model>", "fast model name")
    .option("--pro <model>", "reasoning model name")
    .option("--workspace <id>", "default workspace id", "default")
    .option("--status", "show the current bootstrap state")
    .option("--no-probe", "save without probing the key")
    .option("--json", "machine-readable output")
    .action(async (options: BootstrapOptions) => {
      const profile = readBootstrapProfileSync();
      const key = options.key ?? process.env.DEEPSEEK_API_KEY ?? loadApiKey();

      if (options.status) {
        const state = {
          configured: Boolean(profile),
          hasKey: Boolean(key),
          profile: profile ?? null,
        };
        console.log(JSON.stringify(state, null, 2));
        if (!profile) {
          process.exitCode = 1;
        }
        return;
      }

      if (!key) {
        console.error(
          [
            "No model API key found.",
            "Next steps:",
            "  1. kit bootstrap --key <key>",
            "  2. or open the web console /welcome and paste the key",
            "  3. or export DEEPSEEK_API_KEY",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }

      const baseUrl =
        options.baseUrl ?? profile?.baseUrl ?? "https://api.deepseek.com";
      const flash = options.flash ?? profile?.models.flash ?? "deepseek-flash";
      const pro = options.pro ?? profile?.models.pro ?? "deepseek-v4-pro";

      if (options.probe !== false) {
        const probe = await probeModel({ apiKey: key, baseUrl, model: flash });
        if (!probe.ok) {
          const error = probe.error;
          if (options.json) {
            console.log(JSON.stringify({ ok: false, probe }, null, 2));
          } else {
            console.error(`✖ model probe failed (${error?.kind ?? "unknown"})`);
            console.error(`  ${error?.message ?? "no detail"}`);
            console.error("  Check the key, base URL, network, and quota.");
          }
          process.exitCode = 1;
          return;
        }

        if (!options.json) {
          console.log(`✔ model reachable in ${probe.latencyMs}ms (${flash})`);
          if (probe.models && probe.models.length > 0) {
            console.log(`  models: ${probe.models.slice(0, 8).join(", ")}`);
          }
        }
      }

      const saved = await saveApiKey(key);
      const profilePath = await writeBootstrapProfile({
        apiVersion: "agentteam/v1",
        mode: process.env.KIT_RUNTIME_MODE === "scale" ? "scale" : "local",
        baseUrl,
        models: { flash, pro },
        workspaceId: options.workspace ?? "default",
        createdAt: new Date().toISOString(),
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              profilePath,
              secrets: { path: saved.path, backend: saved.backend },
              models: { flash, pro },
              baseUrl,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✔ key stored (${saved.backend}) at ${saved.path}`);
      console.log(`✔ profile written to ${profilePath}`);
      console.log("Next steps:");
      console.log("  kit up          # start the supervisor");
      console.log("  kit init --list # create your first team");
    });
}
