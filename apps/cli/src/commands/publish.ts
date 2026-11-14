import path from "node:path";
import { bootstrapHome } from "@kit/bootstrap";
import { renderRunFiles } from "@kit/publish";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { PublishSafetyError, buildPublishedRun } from "../publish-model";
import {
  getRemoteUrl,
  githubWebUrl,
  pagesUrl,
  publishSiteToBranch,
} from "../publish-pages";
import { assembleSite } from "../publish-site";

const DEFAULT_SITE_TITLE = "Agent Team Kit · Published runs";
const DEFAULT_SITE_DESCRIPTION =
  "A public archive of runs from a private agent team: artifacts, stages, costs and provenance.";

interface PublishOptions {
  out?: string;
  push: boolean;
  yes: boolean;
  remote: string;
  branch: string;
  siteTitle?: string;
  siteDescription?: string;
  repoUrl?: string;
  baseUrl?: string;
}

export function registerPublish(program: Command): void {
  program
    .command("publish <runId>")
    .description("Publish a run to a static archive site (GitHub Pages)")
    .option(
      "--out <dir>",
      "local site root (default: ~/.agent-team-kit/publish)",
    )
    .option("--push", "publish to the pages branch", false)
    .option("--yes", "confirm publishing artifact content", false)
    .option("--remote <name>", "git remote name", "origin")
    .option("--branch <name>", "pages branch", "gh-pages")
    .option("--site-title <title>", "site title")
    .option("--site-description <text>", "site description")
    .option("--repo-url <url>", "source repository URL")
    .option("--base-url <url>", "public site base URL for canonical links")
    .action(async (runId: string, options: PublishOptions) => {
      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        console.error("✖ cannot reach the kit database");
        console.error(
          `  ${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(
          "  start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
        );
        process.exitCode = 1;
        return;
      }

      try {
        const run = await buildPublishedRun(store, runId);
        const remote = getRemoteUrl(options.remote);
        const repoUrl = options.repoUrl ?? githubWebUrl(remote) ?? undefined;
        const baseUrl =
          options.baseUrl ??
          (options.push ? (pagesUrl(remote) ?? undefined) : undefined);

        const siteOptions = {
          title: options.siteTitle ?? DEFAULT_SITE_TITLE,
          description: options.siteDescription ?? DEFAULT_SITE_DESCRIPTION,
          ...(repoUrl ? { repoUrl } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        };

        const runFiles = renderRunFiles(run, siteOptions);
        const localDir = options.out
          ? path.resolve(options.out)
          : path.join(bootstrapHome(), "publish");

        await assembleSite(localDir, {
          run,
          runFiles,
          options: siteOptions,
          explicitTitle: options.siteTitle !== undefined,
          explicitDescription: options.siteDescription !== undefined,
        });

        console.log(
          `✔ run page: ${path.join(localDir, "runs", safeSegment(runId), "index.html")}`,
        );
        console.log(`  site root: ${localDir}`);
        console.log(`  ${run.artifacts.length} artifact page(s)`);

        if (!options.push) {
          return;
        }

        if (!options.yes) {
          console.error(
            "✖ publishing makes artifact content public; pass --yes to confirm",
          );
          process.exitCode = 1;
          return;
        }
        if (!remote) {
          console.error(`✖ git remote not found: ${options.remote}`);
          console.error("  add a remote first: git remote add origin <url>");
          process.exitCode = 1;
          return;
        }

        const changed = await publishSiteToBranch({
          remoteUrl: remote,
          branch: options.branch,
          message: `publish ${run.runId}`,
          prepare: async (dir) => {
            await assembleSite(dir, {
              run,
              runFiles,
              options: siteOptions,
              explicitTitle: options.siteTitle !== undefined,
              explicitDescription: options.siteDescription !== undefined,
            });
          },
        });

        if (changed) {
          console.log(`✔ published to ${options.remote}/${options.branch}`);
        } else {
          console.log(
            `✔ ${options.remote}/${options.branch} is already current`,
          );
        }
        const url = pagesUrl(remote);
        if (url) {
          console.log(`  ${url}`);
          console.log(
            "  enable Pages in the repository settings (deploy from the branch)",
          );
        }
      } catch (error) {
        if (error instanceof PublishSafetyError) {
          console.error(`✖ refusing to publish: ${error.message}`);
        } else {
          console.error(
            `✖ publish failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exitCode = 1;
      } finally {
        await store.close();
      }
    });
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "item";
}
