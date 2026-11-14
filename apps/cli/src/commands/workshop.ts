import {
  type WorkshopPublishResult,
  installWorkshop,
  previewWorkshop,
  publishWorkshop,
  searchWorkshop,
} from "@kit/workshop";
import type { Command } from "commander";

export function registerWorkshop(program: Command): void {
  const workshop = program
    .command("workshop")
    .description("GitHub creative workshop (packs, workflows, agents, tools)");

  workshop
    .command("search")
    .description("Search GitHub topic agent-team-workshop")
    .option("--query <text>", "extra search terms")
    .option("--limit <n>", "results", "12")
    .action(async (options: { query?: string; limit: string }) => {
      const candidates = await searchWorkshop({
        query: options.query,
        limit: Number(options.limit) || 12,
        token: process.env.GITHUB_TOKEN,
      });
      console.log(JSON.stringify(candidates, null, 2));
    });

  workshop
    .command("preview <repo>")
    .description("Preview a workshop manifest without executing code")
    .option("--ref <ref>", "commit or branch", "main")
    .action(async (repo: string, options: { ref: string }) => {
      const preview = await previewWorkshop({
        repo,
        ref: options.ref === "main" ? undefined : options.ref,
        token: process.env.GITHUB_TOKEN,
      });
      console.log(JSON.stringify(preview, null, 2));
    });

  workshop
    .command("install <repo>")
    .description("Install a workshop item at a pinned commit")
    .option("--ref <ref>", "commit or branch")
    .option("--target <dir>", "target root (default: ./workshop)")
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
    .action(
      async (
        repo: string,
        options: {
          ref?: string;
          target?: string;
          yes: boolean;
          acceptUnsigned: boolean;
          allowCode: boolean;
          acceptRisk: boolean;
        },
      ) => {
        if (!options.yes) {
          console.error("✖ pass --yes to accept third-party workshop content");
          process.exitCode = 1;
          return;
        }
        const installed = await installWorkshop({
          repo,
          ref: options.ref,
          root: options.target,
          acceptThirdParty: true,
          acceptUnsigned: options.acceptUnsigned,
          allowCode: options.allowCode,
          acceptHighRisk: options.acceptRisk,
          token: process.env.GITHUB_TOKEN,
        });
        console.log(JSON.stringify(installed, null, 2));
      },
    );

  workshop
    .command("publish [dir]")
    .description(
      "Generate or validate workshop.yaml and print a publish checklist (never pushes)",
    )
    .option("--check", "validate an existing workshop.yaml without writing")
    .option("--json", "print machine-readable JSON")
    .action(
      async (
        dir: string | undefined,
        options: { check?: boolean; json?: boolean },
      ) => {
        const result = await publishWorkshop({
          dir: dir ?? process.cwd(),
          write: !options.check,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printPublish(result);
        }
        if (!result.ok) {
          process.exitCode = 1;
        }
      },
    );
}

function printPublish(result: WorkshopPublishResult): void {
  const status = result.ok
    ? "✔ publish check passed"
    : "✖ publish check failed";
  console.log(
    `${status} · ${result.manifest.kind} ${result.manifest.name}@${result.manifest.version}`,
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
  console.log(
    `permissions: network=${result.permissions.network ? "yes" : "no"} filesystem=${result.permissions.filesystem} code=${result.permissions.code ? "yes" : "no"}`,
  );
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
