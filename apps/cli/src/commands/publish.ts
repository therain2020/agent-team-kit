import path from "node:path";
import { bootstrapHome } from "@kit/bootstrap";
import { CliError } from "@kit/core";
import { renderRunFiles } from "@kit/publish";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";
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
  idempotencyKey?: string;
  json?: boolean;
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
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(async (runId: string, options: PublishOptions) => {
      const json = wantsJson(options);
      let store: Awaited<ReturnType<typeof initStore>>;
      try {
        store = await initStore();
      } catch (error) {
        emitError(
          json,
          new CliError(
            "dependency_unavailable",
            "cannot reach the kit database",
            {
              hint: "start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
              details: {
                detail: error instanceof Error ? error.message : String(error),
              },
            },
          ),
        );
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

        const runPage = path.join(
          localDir,
          "runs",
          safeSegment(runId),
          "index.html",
        );

        if (!json) {
          console.log(`✔ run page: ${runPage}`);
          console.log(`  site root: ${localDir}`);
          console.log(`  ${run.artifacts.length} artifact page(s)`);
        }

        if (!options.push) {
          emit(json, {
            runId,
            runPage,
            siteRoot: localDir,
            artifacts: run.artifacts.length,
            pushed: false,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          });
          return;
        }

        if (!options.yes) {
          emitError(
            json,
            new CliError(
              "needs_confirmation",
              "publishing makes artifact content public; pass --yes to confirm",
            ),
          );
          return;
        }
        if (!remote) {
          emitError(
            json,
            new CliError(
              "not_found",
              `git remote not found: ${options.remote}`,
              {
                hint: "add a remote first: git remote add origin <url>",
              },
            ),
          );
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

        const url = pagesUrl(remote);
        const data = {
          runId,
          runPage,
          siteRoot: localDir,
          artifacts: run.artifacts.length,
          pushed: true,
          remote: options.remote,
          branch: options.branch,
          changed,
          ...(url ? { url } : {}),
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        };
        emit(json, data, () => {
          if (changed) {
            console.log(`✔ published to ${options.remote}/${options.branch}`);
          } else {
            console.log(
              `✔ ${options.remote}/${options.branch} is already current`,
            );
          }
          if (url) {
            console.log(`  ${url}`);
            console.log(
              "  enable Pages in the repository settings (deploy from the branch)",
            );
          }
        });
      } catch (error) {
        if (error instanceof PublishSafetyError) {
          emitError(
            json,
            new CliError("permission", `refusing to publish: ${error.message}`),
          );
        } else {
          emitError(
            json,
            new CliError(
              "internal",
              `publish failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      } finally {
        await store.close();
      }
    });
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "item";
}
