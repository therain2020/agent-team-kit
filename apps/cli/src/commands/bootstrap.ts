import {
  type CoderInstallResult,
  type ModelProbeResult,
  collectPreflight,
  detectCoderClis,
  installCoderClis,
  loadApiKey,
  markColdStartStarted,
  probeModel,
  readBootstrapProfileSync,
  recordColdStartMilestone,
  resolveRuntimeMode,
  saveApiKey,
  writeBootstrapProfile,
} from "@kit/bootstrap";
import { CliError, type CliErrorCode, exitCodeForCode } from "@kit/core";
import type { Command } from "commander";
import { emitError, printJson } from "../output";
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
  idempotencyKey?: string;
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
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
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
        if (options.json) {
          printJson(state);
          if (!profile) {
            process.exitCode = exitCodeForCode("not_found");
          }
          return;
        }
        console.log(JSON.stringify(state, null, 2));
        if (!profile) {
          process.exitCode = exitCodeForCode("not_found");
        }
        return;
      }

      // Zero-config TTHW clock (plan 91 §5): the first configuration command
      // starts the measurement; a later `kit demo` milestone extends it.
      await markColdStartStarted({
        mode: resolveRuntimeMode(process.env),
      }).catch(() => undefined);

      const installs = options.installCoders
        ? installMissingCoders(Boolean(options.json))
        : [];

      if (!key) {
        const report = await collectPreflight({ probe: false });
        if (options.json) {
          emitError(
            true,
            new CliError("usage", "No model API key found", {
              hint: "kit bootstrap --key <key>, open /welcome, or export DEEPSEEK_API_KEY",
              details: {
                configured: false,
                preflight: report,
                ...(installs.length > 0 ? { coders: installs } : {}),
              },
            }),
          );
        } else {
          printPreflight(report);
          console.error("\n✖ No model API key found. Next steps:");
          console.error("  1. kit bootstrap --key <key>");
          console.error(
            "  2. or open the web console /welcome and paste the key",
          );
          console.error("  3. or export DEEPSEEK_API_KEY");
          process.exitCode = exitCodeForCode("usage");
        }
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
          const code = probeErrorCode(probeResult.error?.kind);
          if (options.json) {
            emitError(
              true,
              new CliError(
                code,
                probeResult.error?.message ?? "model probe failed",
                {
                  hint: "fix the model check and run kit bootstrap again; the key was not saved",
                  details: {
                    probe: probeResult,
                    preflight: report,
                    ...(installs.length > 0 ? { coders: installs } : {}),
                  },
                },
              ),
            );
          } else {
            printPreflight(report);
            console.error(
              "\n✖ key not saved — fix the model check above and run kit bootstrap again",
            );
            process.exitCode = exitCodeForCode(code);
          }
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
      // First-value milestone; the probe latency is excluded per plan 91 §5.
      await recordColdStartMilestone("profile", {
        flow: "kit-bootstrap",
        mode,
        modelLatencyMs: probeResult?.latencyMs ?? null,
      }).catch(() => undefined);
      const report = await collectPreflight({ probeResult });

      if (options.json) {
        printJson({
          profilePath,
          secrets: { path: saved.path, backend: saved.backend },
          models: { flash, pro },
          baseUrl,
          mode,
          preflight: report,
          ...(installs.length > 0 ? { coders: installs } : {}),
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        });
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

function probeErrorCode(kind: string | undefined): CliErrorCode {
  switch (kind) {
    case "auth":
      return "permission";
    case "quota":
      return "budget";
    case "network":
      return "dependency_unavailable";
    case "bad_request":
      return "usage";
    default:
      return "dependency_unavailable";
  }
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
