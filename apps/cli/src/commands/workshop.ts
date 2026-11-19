import { CliError } from "@kit/core";
import {
  type WorkshopManifest,
  type WorkshopPublishResult,
  installWorkshop,
  previewWorkshop,
  publishWorkshop,
  searchWorkshop,
} from "@kit/workshop";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

export function registerWorkshop(program: Command): void {
  const workshop = program
    .command("workshop")
    .description("GitHub creative workshop (packs, workflows, agents, tools)");

  workshop
    .command("search")
    .description("Search GitHub topic agent-team-workshop")
    .option("--query <text>", "extra search terms")
    .option("--limit <n>", "results", "12")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { query?: string; limit: string; json?: boolean }) => {
        const json = wantsJson(options);
        const candidates = await searchWorkshop({
          query: options.query,
          limit: Number(options.limit) || 12,
          token: process.env.GITHUB_TOKEN,
        });
        emit(json, candidates, () => {
          console.log(JSON.stringify(candidates, null, 2));
        });
      },
    );

  workshop
    .command("preview <repo>")
    .description("Preview a workshop manifest without executing code")
    .option("--ref <ref>", "commit or branch", "main")
    .option("--json", "machine-readable output", false)
    .action(async (repo: string, options: { ref: string; json?: boolean }) => {
      const json = wantsJson(options);
      const preview = await previewWorkshop({
        repo,
        ref: options.ref === "main" ? undefined : options.ref,
        token: process.env.GITHUB_TOKEN,
      });
      emit(json, preview, () => {
        console.log(JSON.stringify(preview, null, 2));
      });
    });

  workshop
    .command("install <repo>")
    .description("Install a workshop item at a pinned commit")
    .option("--ref <ref>", "commit or branch")
    .option(
      "--target <dir>",
      "workshop root for non-pack items (default: ./workshop); pack items install into ./packs",
    )
    .option("--overwrite", "replace an existing install target", false)
    .option("--yes", "accept third-party content", false)
    .option(
      "--accept-unsigned",
      "install items without a verified signature",
      false,
    )
    .option("--allow-code", "allow items with executable code", false)
    .option(
      "--accept-risk",
      "accept high-risk permissions (network/code)",
      false,
    )
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (
        repo: string,
        options: {
          ref?: string;
          target?: string;
          overwrite?: boolean;
          yes: boolean;
          acceptUnsigned: boolean;
          allowCode: boolean;
          acceptRisk: boolean;
          idempotencyKey?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        if (!options.yes) {
          emitError(
            json,
            new CliError(
              "needs_confirmation",
              "pass --yes to accept third-party workshop content",
            ),
          );
          return;
        }
        try {
          const installed = await installWorkshop({
            repo,
            ref: options.ref,
            root: options.target,
            overwrite: options.overwrite === true,
            acceptThirdParty: true,
            acceptUnsigned: options.acceptUnsigned,
            allowCode: options.allowCode,
            acceptHighRisk: options.acceptRisk,
            token: process.env.GITHUB_TOKEN,
          });
          emit(
            json,
            {
              ...installed,
              ...(options.idempotencyKey
                ? { idempotencyKey: options.idempotencyKey }
                : {}),
            },
            () => {
              console.log(JSON.stringify(installed, null, 2));
            },
          );
        } catch (error) {
          emitError(json, error);
        }
      },
    );

  workshop
    .command("publish [dir]")
    .description(
      "Generate or validate workshop.yaml and print a publish checklist (never pushes)",
    )
    .option("--check", "validate an existing workshop.yaml without writing")
    .option(
      "--kind <kind>",
      "asset kind when the directory has no workshop.yaml (pack|pipeline|agent|workflow|toolpack|skillpack|template)",
    )
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        dir: string | undefined,
        options: { check?: boolean; kind?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        const result = await publishWorkshop({
          dir: dir ?? process.cwd(),
          kind: options.kind as WorkshopManifest["kind"] | undefined,
          write: !options.check,
        });
        if (!result.ok) {
          if (json) {
            emitError(
              true,
              new CliError("usage", "publish check failed", {
                details: result,
              }),
            );
          } else {
            printPublish(result);
            process.exitCode = 2;
          }
          return;
        }
        emit(json, result, () => {
          printPublish(result);
        });
      },
    );
}

function printPublish(result: WorkshopPublishResult): void {
  const status = result.ok
    ? "✔ publish check passed"
    : "✖ publish check failed";
  const subject = result.manifest
    ? `${result.manifest.kind} ${result.manifest.name}@${result.manifest.version}`
    : `${result.kind ?? "unknown"} (no manifest)`;
  console.log(
    `${status} · ${subject}${
      result.publisher ? ` · ${result.publisher} publisher` : ""
    }`,
  );
  console.log(
    `manifest: ${result.manifestPath}${
      result.generated
        ? result.written
          ? " (generated and written)"
          : " (generated, not written)"
        : ""
    }`,
  );
  console.log(`risk: ${result.risk.level} — ${result.risk.reasons.join(", ")}`);
  if (result.permissions) {
    console.log(
      `permissions: network=${result.permissions.network ? "yes" : "no"} filesystem=${result.permissions.filesystem} code=${result.permissions.code ? "yes" : "no"}`,
    );
  }
  console.log(`files (${result.files.length}):`);
  for (const file of result.files) {
    console.log(`  ${file.path}  ${file.sha256}  ${file.bytes} bytes`);
  }
  console.log("checks:");
  for (const item of result.checks) {
    const mark =
      item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✖";
    console.log(`  ${mark} ${item.id}: ${item.detail}`);
  }
  console.log("next:");
  console.log(
    "  - Add the GitHub topic agent-team-workshop to the repository.",
  );
  console.log(
    "  - Review the files above, commit workshop.yaml, and push from your own terminal.",
  );
}
