import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bootstrapHome } from "@kit/bootstrap";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { getRemoteUrl, pagesUrl, publishSiteToBranch } from "../publish-pages";
import { type PublishArtifact, renderSite } from "../publish-render";

interface PublishOptions {
  out?: string;
  push: boolean;
  yes: boolean;
  remote: string;
  branch: string;
}

export function registerPublish(program: Command): void {
  program
    .command("publish <runId>")
    .description(
      "Render a run as a static site, optionally push it to GitHub Pages",
    )
    .option("--out <dir>", "output directory")
    .option("--push", "publish to the pages branch", false)
    .option("--yes", "confirm publishing artifact content", false)
    .option("--remote <name>", "git remote name", "origin")
    .option("--branch <name>", "pages branch", "gh-pages")
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
        const run = await store.runs.get(runId);
        if (!run) {
          console.error(`✖ run not found: ${runId}`);
          process.exitCode = 1;
          return;
        }

        const artifacts = await store.artifactStore.listByRun(runId);
        const published: PublishArtifact[] = [];
        for (const artifact of artifacts) {
          const manifest = await store.manifests.get(artifact.manifestId);
          if (manifest?.stageId.includes(":tool:")) {
            continue;
          }
          const blob = await store.blobs.findById(artifact.blobId);
          if (!blob) {
            continue;
          }
          const bytes = await store.blobClient.get(blob.storageKey);
          published.push({
            artifactId: artifact.artifactId,
            stageId: manifest?.stageId ?? "unknown",
            createdAt: artifact.createdAt,
            text: new TextDecoder().decode(bytes),
          });
        }

        if (published.length === 0) {
          console.error(`✖ no publishable artifacts for ${runId}`);
          process.exitCode = 1;
          return;
        }

        const site = renderSite({
          runId: run.runId,
          workflowId: run.workflowId,
          status: run.status,
          createdAt: run.createdAt,
          artifacts: published,
        });
        const outDir = options.out
          ? path.resolve(options.out)
          : path.join(bootstrapHome(), "publish", run.runId);

        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, "index.html"), site.index, "utf8");
        for (const [name, html] of Object.entries(site.pages)) {
          await writeFile(path.join(outDir, name), html, "utf8");
        }

        console.log(`✔ site written to ${outDir}`);
        console.log(`  ${published.length} artifact page(s)`);

        if (options.push) {
          if (!options.yes) {
            console.error(
              "✖ publishing makes artifact content public; pass --yes to confirm",
            );
            process.exitCode = 1;
            return;
          }
          const remote = getRemoteUrl(options.remote);
          if (!remote) {
            console.error(`✖ git remote not found: ${options.remote}`);
            console.error("  add a remote first: git remote add origin <url>");
            process.exitCode = 1;
            return;
          }

          try {
            await publishSiteToBranch({
              siteDir: outDir,
              remoteUrl: remote,
              branch: options.branch,
              message: `publish ${run.runId}`,
            });
            console.log(`✔ pushed to ${options.remote}/${options.branch}`);
            const url = pagesUrl(remote);
            if (url) {
              console.log(`  ${url}`);
              console.log(
                "  enable Pages in the repository settings (deploy from the branch). Private repositories need a GitHub plan with Pages.",
              );
            }
          } catch (error) {
            console.error(
              `✖ publish failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exitCode = 1;
          }
        }
      } finally {
        await store.sql.end();
      }
    });
}
