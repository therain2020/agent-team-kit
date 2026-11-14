import {
  installWorkshop,
  previewWorkshop,
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
    .option("--allow-code", "allow items with executable code", false)
    .action(
      async (
        repo: string,
        options: {
          ref?: string;
          target?: string;
          yes: boolean;
          allowCode: boolean;
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
          allowCode: options.allowCode,
          token: process.env.GITHUB_TOKEN,
        });
        console.log(JSON.stringify(installed, null, 2));
      },
    );
}
