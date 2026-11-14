import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SOURCE_TOPIC,
  fetchEvidence,
  installSource,
  listInstalledSources,
  removeSource,
  searchSources,
  testSource,
} from "@kit/source";
import type { Command } from "commander";

export function registerSource(program: Command): void {
  const source = program.command("source").description("Sources and market");

  source
    .command("fetch")
    .description("Fetch evidence from builtin or installed sources")
    .option("--sources <list>", "comma-separated source names", "hn,arxiv")
    .option("--limit <n>", "per-source item limit", "5")
    .option("--out <path>", "output file", ".tmp/evidence.json")
    .action(
      async (options: { sources: string; limit: string; out: string }) => {
        const sources = options.sources
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

        if (sources.length === 0) {
          console.error("✖ no valid sources");
          process.exitCode = 1;
          return;
        }

        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          console.error("✖ --limit must be a positive integer");
          process.exitCode = 1;
          return;
        }

        const evidence = await fetchEvidence({ sources, limit });
        const outPath = path.resolve(options.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, JSON.stringify(evidence, null, 2), "utf8");

        console.log(
          JSON.stringify(
            {
              out: outPath,
              sources: evidence.sources.length,
              citations: evidence.sources.map((item) => item.citationId),
              errors: evidence.errors,
            },
            null,
            2,
          ),
        );
      },
    );

  source
    .command("search")
    .description(
      `Discover sources tagged with the ${SOURCE_TOPIC} GitHub topic`,
    )
    .option("--query <text>", "extra GitHub search terms")
    .option("--topic <name>", "GitHub topic", SOURCE_TOPIC)
    .option("--limit <n>", "max repositories", "12")
    .action(
      async (options: { query?: string; topic: string; limit: string }) => {
        try {
          const candidates = await searchSources({
            query: options.query,
            topic: options.topic,
            limit: Number(options.limit),
            token: process.env.GITHUB_TOKEN,
          });
          if (candidates.length === 0) {
            console.log("No sources found.");
            return;
          }
          for (const item of candidates) {
            const label = item.manifest
              ? `${item.manifest.metadata.name}@${item.manifest.metadata.version}`
              : "invalid manifest";
            console.log(
              `${item.repo}  ★${item.stars}  ${label}${
                item.manifestError ? `  ! ${item.manifestError}` : ""
              }`,
            );
            if (item.description) {
              console.log(`  ${item.description}`);
            }
          }
          console.log(
            "\nInstall with: bun run kit source install <owner/repo> --yes",
          );
        } catch (error) {
          report("search", error);
        }
      },
    );

  source
    .command("install <repo>")
    .description(
      "Install a declarative source from GitHub (pinned to a commit)",
    )
    .option("--ref <ref>", "branch, tag or commit (default branch if omitted)")
    .option("--file <path>", "manifest path", "source.yaml")
    .option("--yes", "confirm third-party source installation", false)
    .action(
      async (
        repo: string,
        options: { ref?: string; file: string; yes: boolean },
      ) => {
        if (!options.yes) {
          console.error(
            "✖ third-party sources require --yes after reviewing source.yaml",
          );
          console.error(
            `  preview: https://github.com/${repo}/blob/HEAD/${options.file}`,
          );
          process.exitCode = 1;
          return;
        }
        try {
          const installed = await installSource({
            repo,
            ref: options.ref,
            file: options.file,
            token: process.env.GITHUB_TOKEN,
            acceptThirdParty: true,
          });
          console.log(
            JSON.stringify(
              {
                name: installed.definition.metadata.name,
                version: installed.definition.metadata.version,
                repo: installed.meta.repo,
                commit: installed.meta.commit,
                manifestSha256: installed.meta.manifestSha256,
                file: installed.file,
              },
              null,
              2,
            ),
          );
          console.log(
            "Third-party source installed. Review its source.yaml and comply with its terms.",
          );
        } catch (error) {
          report("install", error);
        }
      },
    );

  source
    .command("list")
    .description("List installed sources")
    .action(async () => {
      const sources = await listInstalledSources();
      if (sources.length === 0) {
        console.log("No installed sources. Builtins: hn, arxiv, github.");
        return;
      }
      for (const item of sources) {
        console.log(
          `${item.definition.metadata.name}@${item.definition.metadata.version}  ${item.meta.repo}@${item.meta.commit.slice(0, 8)}  ${item.meta.trust}`,
        );
      }
    });

  source
    .command("test <name>")
    .description("Fetch a few items from an installed source")
    .option("--limit <n>", "item limit", "3")
    .action(async (name: string, options: { limit: string }) => {
      try {
        const result = await testSource(name, {
          limit: Number(options.limit),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        report("test", error);
      }
    });

  source
    .command("remove <name>")
    .description("Remove an installed source")
    .action(async (name: string) => {
      try {
        await removeSource(name);
        console.log(`✔ removed ${name}`);
      } catch (error) {
        report("remove", error);
      }
    });
}

function report(command: string, error: unknown): void {
  console.error(
    `✖ source ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
