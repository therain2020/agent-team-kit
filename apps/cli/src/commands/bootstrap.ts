import {
  type CoderInstallResult,
  type ModelProbeResult,
  collectPreflight,
  detectCoderClis,
  installCoderClis,
  loadApiKey,
  probeModel,
  readBootstrapProfileSync,
  resolveRuntimeMode,
  saveApiKey,
  writeBootstrapProfile,
} from "@kit/bootstrap";
import type { Command } from "commander";
import { printPreflight } from "../preflight-output";

interface BootstrapOptions {
  key?: string;
  baseUrl?: string;
  flash?: string;
  pro?: string;
  workspace?: string;
  status?: boolean;
  probe?: boolean;
  installCoders?: boolean;
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
    .option(
      "--install-coders",
      "install missing coder CLIs (dsh, codex, opencode, pi) with npm",
      false,
    )
    .option("--json", "machine-readable output")
    .action(async (options: BootstrapOptions) => {
      const profile = readBootstrapProfileSync();
      const key = options.key ?? process.env.DEEPSEEK_API_KEY ?? loadApiKey();

      if (options.status) {
        const state = {
          configured: Boolean(profile),
          hasKey: Boolean(key),
          mode: resolveRuntimeMode(process.env),
          profile: profile ?? null,
        };
        console.log(JSON.stringify(state, null, 2));
        if (!profile) {
          process.exitCode = 1;
        }
        return;
      }

      const installs = options.installCoders
        ? installMissingCoders(Boolean(options.json))
        : [];

      if (!key) {
        const report = await collectPreflight({ probe: false });
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                ok: false,
                configured: false,
                preflight: report,
                ...(installs.length > 0 ? { coders: installs } : {}),
              },
              null,
              2,
            ),
          );
        } else {
          printPreflight(report);
          console.error("\n✖ No model API key found. Next steps:");
          console.error("  1. kit bootstrap --key <key>");
          console.error(
            "  2. or open the web console /welcome and paste the key",
          );
          console.error("  3. or export DEEPSEEK_API_KEY");
        }
        process.exitCode = 1;
        return;
      }

      const baseUrl =
        options.baseUrl ?? profile?.baseUrl ?? "https://api.deepseek.com";
      const flash = options.flash ?? profile?.models.flash ?? "deepseek-flash";
      const pro = options.pro ?? profile?.models.pro ?? "deepseek-v4-pro";

      let probeResult: ModelProbeResult | undefined;
      if (options.probe !== false) {
        probeResult = await probeModel({ apiKey: key, baseUrl, model: flash });
        if (!probeResult.ok) {
          const report = await collectPreflight({ probeResult });
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  probe: probeResult,
                  preflight: report,
                  ...(installs.length > 0 ? { coders: installs } : {}),
                },
                null,
                2,
              ),
            );
          } else {
            printPreflight(report);
            console.error(
              "\n✖ key not saved — fix the model check above and run kit bootstrap again",
            );
          }
          process.exitCode = 1;
          return;
        }

        if (!options.json) {
          console.log(
            `✔ model reachable in ${probeResult.latencyMs}ms (${flash})`,
          );
          if (probeResult.models && probeResult.models.length > 0) {
            console.log(
              `  models: ${probeResult.models.slice(0, 8).join(", ")}`,
            );
          }
        }
      }

      const saved = await saveApiKey(key);
      const mode = resolveRuntimeMode(process.env);
      const profilePath = await writeBootstrapProfile({
        apiVersion: "agentteam/v1",
        mode,
        baseUrl,
        models: { flash, pro },
        workspaceId: options.workspace ?? "default",
        createdAt: new Date().toISOString(),
      });
      const report = await collectPreflight({ probeResult });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              profilePath,
              secrets: { path: saved.path, backend: saved.backend },
              models: { flash, pro },
              baseUrl,
              mode,
              preflight: report,
              ...(installs.length > 0 ? { coders: installs } : {}),
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✔ key stored (${saved.backend}) at ${saved.path}`);
      console.log(`✔ profile written to ${profilePath}`);
      console.log("");
      printPreflight(report);
      console.log("\nNext steps:");
      console.log("  kit up          # start the supervisor");
      console.log("  kit init --list # create your first team");
    });
}

function installMissingCoders(json: boolean): CoderInstallResult[] {
  const missing = detectCoderClis().filter((detection) => !detection.path);
  if (!json) {
    if (missing.length === 0) {
      console.log("✔ all supported coder CLIs are installed");
      return [];
    }
    console.log(`Installing ${missing.length} missing coder CLI(s):`);
    for (const { spec } of missing) {
      console.log(`  ${spec.install.join(" ")}`);
    }
  }

  const results = installCoderClis(missing);
  if (!json) {
    for (const result of results) {
      console.log(`${result.ok ? "✔" : "✖"} ${result.id} — ${result.command}`);
      if (!result.ok && result.output) {
        console.error(
          result.output
            .split(/\r?\n/)
            .map((line) => `    ${line}`)
            .join("\n"),
        );
      }
    }
  }
  return results;
}
