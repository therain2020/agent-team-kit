import path from "node:path";
import {
  StoreEvolutionRepository,
  canaryStatus,
  compareVariants,
  evaluateCanary,
  initVariant,
  loadEvolutionCycles,
  promoteVariant,
  proposeVariant,
  rollbackCanary,
  runEvolutionCycle,
  scoreVariant,
  startCanary,
} from "@kit/evolution";
import { initStore, loadStoreConfig } from "@kit/store";
import type { Command } from "commander";

export function registerEvolve(program: Command): void {
  const evolve = program
    .command("evolve")
    .description("Variant evolution lab (local)");

  evolve
    .command("init <packDir>")
    .description("Create a baseline variant from a pack")
    .requiredOption("--out <dir>", "variant output directory")
    .requiredOption("--name <name>", "variant name")
    .action(async (packDir: string, options: { out: string; name: string }) => {
      try {
        const result = await withEvolutionRepo(async (repo) => {
          const created = await initVariant(packDir, options.out, options.name);
          await repo.saveVariant({
            meta: created.meta,
            dir: created.dir,
            packDir: path.resolve(packDir),
          });
          return created;
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        reportError("init", error);
      }
    });

  evolve
    .command("propose <fromDir>")
    .description("Create a child variant with a changed agent")
    .requiredOption("--agent <id>", "agent id")
    .requiredOption("--file <path>", "new role instructions")
    .requiredOption("--out <dir>", "variant output directory")
    .requiredOption("--name <name>", "variant name")
    .option("--model <alias>", "override model alias")
    .action(
      async (
        fromDir: string,
        options: {
          agent: string;
          file: string;
          out: string;
          name: string;
          model?: string;
        },
      ) => {
        try {
          const result = await withEvolutionRepo(async (repo) => {
            const created = await proposeVariant(
              fromDir,
              options.agent,
              options.file,
              options.out,
              options.name,
              options.model,
            );
            await repo.saveVariant({
              meta: created.meta,
              dir: created.dir,
              packDir: path.resolve(fromDir),
            });
            return created;
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          reportError("propose", error);
        }
      },
    );

  evolve
    .command("score <variantDir>")
    .description("Score a variant against a baseline (shadow run)")
    .requiredOption("--baseline <dir>", "baseline pack directory")
    .requiredOption("--input-file <path>", "evidence input file")
    .requiredOption("--agent <id>", "agent id to score")
    .option("--rubric <ref>", "rubric ref", "evals/rubrics.yaml#radar")
    .option("--stub", "deterministic stub instead of live models", false)
    .action(
      async (
        variantDir: string,
        options: {
          baseline: string;
          inputFile: string;
          agent: string;
          rubric: string;
          stub: boolean;
        },
      ) => {
        try {
          const record = await withEvolutionRepo((repo) =>
            scoreVariant(
              variantDir,
              options.baseline,
              options.inputFile,
              options.agent,
              { stub: options.stub, rubricRef: options.rubric, repo },
            ),
          );
          console.log(JSON.stringify(record, null, 2));
        } catch (error) {
          reportError("score", error);
        }
      },
    );

  const canary = evolve
    .command("canary")
    .description("Canary evaluation and rollback");

  canary
    .command("start")
    .description("Register a canary variant against a champion")
    .requiredOption("--baseline <dir>", "champion variant directory")
    .requiredOption("--variant <dir>", "canary variant directory")
    .requiredOption("--percent <n>", "traffic percent", "20")
    .action(
      async (options: {
        baseline: string;
        variant: string;
        percent: string;
      }) => {
        try {
          const state = await withEvolutionRepo((repo) =>
            startCanary(
              options.baseline,
              options.variant,
              Number(options.percent),
              undefined,
              repo,
            ),
          );
          console.log(JSON.stringify(state, null, 2));
        } catch (error) {
          reportError("canary start", error);
        }
      },
    );

  canary
    .command("evaluate")
    .description(
      "Shadow-evaluate champion and canary, auto-rollback on regression",
    )
    .requiredOption("--inputs <list>", "comma-separated input files")
    .option("--stub", "deterministic stub instead of live models", false)
    .action(async (options: { inputs: string; stub: boolean }) => {
      try {
        const inputs = options.inputs
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const result = await withEvolutionRepo((repo) =>
          evaluateCanary(inputs, { stub: options.stub, repo }),
        );
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        reportError("canary evaluate", error);
      }
    });

  canary
    .command("status")
    .description("Show canary state")
    .action(async () => {
      const state = await withEvolutionRepo((repo) =>
        canaryStatus(undefined, repo),
      );
      console.log(JSON.stringify(state, null, 2));
    });

  canary
    .command("rollback")
    .description("Manually roll back the canary")
    .option("--reason <text>", "rollback reason", "manual rollback")
    .action(async (options: { reason: string }) => {
      try {
        const state = await withEvolutionRepo((repo) =>
          rollbackCanary(options.reason, undefined, repo),
        );
        console.log(JSON.stringify(state, null, 2));
      } catch (error) {
        reportError("canary rollback", error);
      }
    });

  evolve
    .command("cycle <packDir>")
    .description(
      "Run one self-evolution cycle: signals → proposal → evaluation → canary",
    )
    .requiredOption("--input-file <path>", "evidence input for evaluation")
    .option("--agent <id>", "agent to evolve (auto if omitted)")
    .option("--signal <text>", "extra failure signal (repeatable)", collect, [])
    .option("--stub", "deterministic proposal and checks", false)
    .option(
      "--auto-apply",
      "promote automatically after a passed canary",
      false,
    )
    .option("--force", "run even without archive failure signals", false)
    .option("--budget <cny>", "cycle budget in CNY")
    .action(
      async (
        packDir: string,
        options: {
          inputFile: string;
          agent?: string;
          signal: string[];
          stub: boolean;
          autoApply: boolean;
          force: boolean;
          budget?: string;
        },
      ) => {
        try {
          const record = await withEvolutionRepo((repo) =>
            runEvolutionCycle({
              packDir,
              agentId: options.agent,
              inputFile: options.inputFile,
              signals: options.signal,
              stub: options.stub,
              autoApply: options.autoApply,
              force: options.force,
              budgetCny: options.budget ? Number(options.budget) : undefined,
              repo,
            }),
          );
          console.log(JSON.stringify(record, null, 2));
          if (record.decision === "failed") {
            process.exitCode = 1;
          }
        } catch (error) {
          reportError("cycle", error);
        }
      },
    );

  evolve
    .command("cycles")
    .description("Show recent evolution cycles")
    .option("--limit <n>", "max records", "20")
    .action(async (options: { limit: string }) => {
      console.log(
        JSON.stringify(
          await withEvolutionRepo((repo) =>
            loadEvolutionCycles(undefined, Number(options.limit), repo),
          ),
          null,
          2,
        ),
      );
    });

  evolve
    .command("compare")
    .description("Compare latest scores per variant")
    .action(async () => {
      const variants = await withEvolutionRepo((repo) =>
        compareVariants(undefined, repo),
      );
      console.log(JSON.stringify(variants, null, 2));
    });

  evolve
    .command("promote <variantDir>")
    .description("Promote a variant into a target pack")
    .requiredOption("--target <dir>", "target pack directory")
    .option("--apply", "write changes (default is dry-run)", false)
    .action(
      async (
        variantDir: string,
        options: { target: string; apply: boolean },
      ) => {
        try {
          const result = await withEvolutionRepo((repo) =>
            promoteVariant(variantDir, options.target, options.apply, repo),
          );
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          reportError("promote", error);
        }
      },
    );
}

async function withEvolutionRepo<T>(
  fn: (repo: StoreEvolutionRepository) => Promise<T>,
): Promise<T> {
  const store = await initStore(loadStoreConfig());
  try {
    const repo = new StoreEvolutionRepository(store, {
      variantsRoot: path.resolve("variants"),
    });
    return await fn(repo);
  } finally {
    await store.close();
  }
}

function reportError(command: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✖ evolve ${command} failed: ${message}`);
  process.exitCode = 1;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
