import { existsSync } from "node:fs";
import path from "node:path";
import { CliError } from "@kit/core";
import {
  DEFAULT_CONVERGENCE_WINDOW,
  DEFAULT_DIVERGENCE_WINDOW,
  type EvolutionFreezeKind,
  type OutcomeSource,
  StoreEvolutionRepository,
  buildDivergencePoints,
  canaryStatus,
  compareVariants,
  convergenceGuard,
  defaultCyclesRoot,
  defaultGovernancePath,
  defaultHiddenEvalsDir,
  defaultOutcomesPath,
  divergenceGuard,
  evaluateCanary,
  evaluatorAgreement,
  evolutionCostReport,
  freezeEvolution,
  initVariant,
  loadEvolutionCycles,
  loadFreezeState,
  loadGovernanceEvents,
  promoteVariant,
  proposeVariant,
  readOutcomeObservations,
  recordOutcome,
  rollbackCanary,
  runEvolutionCycle,
  scoreVariant,
  setCanaryTraffic,
  startCanary,
  summarizeOutcomes,
  unfreezeEvolution,
  verifyEvalSnapshot,
} from "@kit/evolution";
import { initStore, loadStoreConfig } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface JsonFlag {
  json?: boolean;
}

export function registerEvolve(program: Command): void {
  const evolve = program
    .command("evolve")
    .description("Variant evolution lab (local)");

  evolve
    .command("init <packDir>")
    .description("Create a baseline variant from a pack")
    .requiredOption("--out <dir>", "variant output directory")
    .requiredOption("--name <name>", "variant name")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        packDir: string,
        options: { out: string; name: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        try {
          const result = await withEvolutionRepo(async (repo) => {
            const created = await initVariant(
              packDir,
              options.out,
              options.name,
            );
            await repo.saveVariant({
              meta: created.meta,
              dir: created.dir,
              packDir: path.resolve(packDir),
            });
            return created;
          });
          emitResult(json, result);
        } catch (error) {
          reportError("init", error, json);
        }
      },
    );

  evolve
    .command("propose <fromDir>")
    .description("Create a child variant with a changed agent")
    .requiredOption("--agent <id>", "agent id")
    .requiredOption("--file <path>", "new role instructions")
    .requiredOption("--out <dir>", "variant output directory")
    .requiredOption("--name <name>", "variant name")
    .option("--model <alias>", "override model alias")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        fromDir: string,
        options: {
          agent: string;
          file: string;
          out: string;
          name: string;
          model?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
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
          emitResult(json, result);
        } catch (error) {
          reportError("propose", error, json);
        }
      },
    );

  evolve
    .command("score <variantDir>")
    .description("Score a variant against a baseline (shadow run)")
    .requiredOption("--baseline <dir>", "baseline pack directory")
    .requiredOption("--input-file <path>", "evidence input file")
    .requiredOption("--agent <id>", "agent id to score")
    .option("--rubric <ref>", "rubric ref", "evals/visible/rubrics.yaml#radar")
    .option("--stub", "deterministic stub instead of live models", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (
        variantDir: string,
        options: {
          baseline: string;
          inputFile: string;
          agent: string;
          rubric: string;
          stub: boolean;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
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
          emitResult(json, record);
        } catch (error) {
          reportError("score", error, json);
        }
      },
    );

  const canary = evolve
    .command("canary")
    .description("Canary evaluation and rollback");

  canary
    .command("start")
    .description("Register a canary variant (shadow by default)")
    .requiredOption("--baseline <dir>", "champion variant directory")
    .requiredOption("--variant <dir>", "canary variant directory")
    .option("--percent <n>", "traffic percent (0 stays in shadow)", "0")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        baseline: string;
        variant: string;
        percent: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const state = await withEvolutionRepo((repo) =>
            startCanary(options.baseline, options.variant, {
              trafficPercent: Number(options.percent),
              repo,
            }),
          );
          emitResult(json, state);
        } catch (error) {
          reportError("canary start", error, json);
        }
      },
    );

  canary
    .command("traffic")
    .description("Set the live traffic percent for the active canary")
    .requiredOption("--percent <n>", "traffic percent between 0 and 99")
    .option("--json", "machine-readable output", false)
    .action(async (options: { percent: string; json?: boolean }) => {
      const json = wantsJson(options);
      try {
        const state = await withEvolutionRepo((repo) =>
          setCanaryTraffic(Number(options.percent), { repo }),
        );
        emitResult(json, state);
      } catch (error) {
        reportError("canary traffic", error, json);
      }
    });

  canary
    .command("evaluate")
    .description("Evaluate champion and canary, auto-rollback on regression")
    .requiredOption("--inputs <list>", "comma-separated input files")
    .option("--stub", "deterministic stub instead of live models", false)
    .option("--incident <text>", "force rollback for an incident")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        inputs: string;
        stub: boolean;
        incident?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const inputs = options.inputs
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const result = await withEvolutionRepo((repo) =>
            evaluateCanary(inputs, {
              stub: options.stub,
              repo,
              ...(options.incident ? { incident: options.incident } : {}),
            }),
          );
          emitResult(json, result);
        } catch (error) {
          reportError("canary evaluate", error, json);
        }
      },
    );

  canary
    .command("status")
    .description("Show canary state")
    .option("--json", "machine-readable output", false)
    .action(async (options: JsonFlag) => {
      const json = wantsJson(options);
      const state = await withEvolutionRepo((repo) => canaryStatus({ repo }));
      emitResult(json, state);
    });

  canary
    .command("rollback")
    .description("Manually roll back the canary")
    .option("--reason <text>", "rollback reason", "manual rollback")
    .option("--trigger <kind>", "manual | incident", "manual")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        reason: string;
        trigger: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const state = await withEvolutionRepo((repo) =>
            rollbackCanary(options.reason, {
              repo,
              ...(options.trigger === "incident"
                ? { trigger: "incident" as const }
                : {}),
            }),
          );
          emitResult(json, state);
        } catch (error) {
          reportError("canary rollback", error, json);
        }
      },
    );

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
    .option("--force", "run even without failure signals", false)
    .option("--budget <cny>", "cycle budget in CNY")
    .option("--budget-tokens <n>", "cycle token budget cap")
    .option(
      "--convergence-window <n>",
      "consecutive no-improvement cycles before an auto-freeze",
      String(DEFAULT_CONVERGENCE_WINDOW),
    )
    .option(
      "--divergence-window <n>",
      "consecutive score-up/outcome-flat cycles before a Goodhart pause",
      String(DEFAULT_DIVERGENCE_WINDOW),
    )
    .option(
      "--outcomes-file <path>",
      "outcome observations from acceptance or human review (default <signals root>/outcomes.jsonl)",
    )
    .option(
      "--drift-file <path>",
      "drift baseline file (default variants/drift-baseline.json)",
    )
    .option(
      "--governance-file <path>",
      "divergence/drift event log (default variants/governance.jsonl)",
    )
    .option(
      "--model-pin <pin>",
      "provider pin for model drift (default KIT_MODEL_PROVIDER_PIN)",
    )
    .option(
      "--freeze-file <path>",
      "freeze state file (default variants/freeze.json)",
    )
    .option(
      "--signals-root <dir>",
      "directory holding iterations.jsonl (default KIT_SIGNALS_ROOT or ~/.agent-team-kit/signals)",
    )
    .option("--cycles-root <dir>", "external root for frozen eval snapshots")
    .option(
      "--hidden-evals <dir>",
      "hidden eval directory to freeze (default <KIT_HIDDEN_EVALS_ROOT>/<workspace>)",
    )
    .option(
      "--approve-evaluator-change",
      "approve a changed evaluator for this cycle",
      false,
    )
    .option(
      "--approval-ref <id>",
      "approval reference for the evaluator change",
    )
    .option("--json", "machine-readable output", false)
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
          budgetTokens?: string;
          convergenceWindow: string;
          divergenceWindow: string;
          outcomesFile?: string;
          driftFile?: string;
          governanceFile?: string;
          modelPin?: string;
          freezeFile?: string;
          signalsRoot?: string;
          cyclesRoot?: string;
          hiddenEvals?: string;
          approveEvaluatorChange: boolean;
          approvalRef?: string;
          json?: boolean;
        },
      ) => {
        const json = wantsJson(options);
        const convergenceWindow = Number(options.convergenceWindow);
        if (!Number.isInteger(convergenceWindow) || convergenceWindow < 1) {
          emitError(
            json,
            new CliError(
              "usage",
              "convergence-window must be a positive integer",
            ),
          );
          return;
        }
        const divergenceWindow = Number(options.divergenceWindow);
        if (!Number.isInteger(divergenceWindow) || divergenceWindow < 1) {
          emitError(
            json,
            new CliError(
              "usage",
              "divergence-window must be a positive integer",
            ),
          );
          return;
        }
        try {
          const record = await withEvolutionRepo(async (repo) => {
            const hiddenEvalsDir =
              options.hiddenEvals ?? defaultHiddenDir(repo.workspaceId);
            return await runEvolutionCycle({
              packDir,
              agentId: options.agent,
              inputFile: options.inputFile,
              signals: options.signal,
              stub: options.stub,
              autoApply: options.autoApply,
              force: options.force,
              budgetCny: options.budget ? Number(options.budget) : undefined,
              ...(options.budgetTokens
                ? { budgetTokens: Number(options.budgetTokens) }
                : {}),
              convergenceWindow,
              divergenceWindow,
              ...(options.outcomesFile
                ? { outcomesPath: options.outcomesFile }
                : {}),
              ...(options.driftFile
                ? { driftBaselinePath: options.driftFile }
                : {}),
              ...(options.governanceFile
                ? { governancePath: options.governanceFile }
                : {}),
              ...(options.modelPin ? { modelPin: options.modelPin } : {}),
              ...(options.freezeFile ? { freezePath: options.freezeFile } : {}),
              signalsRoot: options.signalsRoot,
              cyclesRoot: options.cyclesRoot,
              workspaceId: repo.workspaceId,
              ...(hiddenEvalsDir ? { hiddenEvalsDir } : {}),
              ...(options.approveEvaluatorChange
                ? { allowEvaluatorChange: true }
                : {}),
              ...(options.approvalRef
                ? { evaluatorApprovalRef: options.approvalRef }
                : {}),
              repo,
            });
          });
          emitResult(json, record);
          if (record.decision === "failed") {
            process.exitCode = 1;
          }
        } catch (error) {
          reportError("cycle", error, json);
        }
      },
    );

  evolve
    .command("cycles")
    .description("Show recent evolution cycles")
    .option("--limit <n>", "max records", "20")
    .option("--json", "machine-readable output", false)
    .action(async (options: { limit: string; json?: boolean }) => {
      const json = wantsJson(options);
      const cycles = await withEvolutionRepo((repo) =>
        loadEvolutionCycles(undefined, Number(options.limit), repo),
      );
      emitResult(json, cycles);
    });

  evolve
    .command("freeze")
    .description(
      "Freeze evolution: incident, manual, convergence or divergence stop",
    )
    .requiredOption("--reason <text>", "why evolution is frozen")
    .option(
      "--kind <kind>",
      "incident | manual | convergence | divergence",
      "manual",
    )
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option(
      "--lift-condition <text>",
      "what must happen before the freeze can be lifted",
    )
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        reason: string;
        kind: string;
        actor: string;
        liftCondition?: string;
        idempotencyKey?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const kind = parseFreezeKind(options.kind);
        if (!kind) {
          emitError(
            json,
            new CliError(
              "usage",
              "kind must be incident, manual, convergence, or divergence",
            ),
          );
          return;
        }
        try {
          const state = await withEvolutionRepo((repo) =>
            freezeEvolution(
              {
                kind,
                reason: options.reason,
                actor: options.actor,
                ...(options.liftCondition
                  ? { liftCondition: options.liftCondition }
                  : {}),
              },
              { repo },
            ),
          );
          emitResult(json, withIdempotencyKey(state, options.idempotencyKey));
        } catch (error) {
          reportError("freeze", error, json);
        }
      },
    );

  evolve
    .command("unfreeze")
    .description("Lift the evolution freeze")
    .option("--reason <text>", "why evolution is resumed")
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        reason?: string;
        actor: string;
        idempotencyKey?: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        try {
          const state = await withEvolutionRepo((repo) =>
            unfreezeEvolution(
              {
                ...(options.reason ? { reason: options.reason } : {}),
                actor: options.actor,
              },
              { repo },
            ),
          );
          emitResult(json, withIdempotencyKey(state, options.idempotencyKey));
        } catch (error) {
          reportError("unfreeze", error, json);
        }
      },
    );

  evolve
    .command("status")
    .description(
      "Show freeze state, convergence streak, Goodhart divergence, drift findings and evolution cost share",
    )
    .option("--days <n>", "cost window in days", "30")
    .option("--cycles <n>", "recent cycles to consider", "50")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { days: string; cycles: string; json?: boolean }) => {
        const json = wantsJson(options);
        const days = Number(options.days);
        const limit = Number(options.cycles);
        if (!Number.isFinite(days) || days <= 0) {
          emitError(
            json,
            new CliError("usage", "days must be a positive number"),
          );
          return;
        }
        if (!Number.isInteger(limit) || limit < 1) {
          emitError(
            json,
            new CliError("usage", "cycles must be a positive integer"),
          );
          return;
        }
        try {
          const data = await withEvolutionRepo(async (repo) => {
            const freeze = await loadFreezeState({ repo });
            const cycles = await loadEvolutionCycles(undefined, limit, repo);
            const guard = convergenceGuard(cycles, DEFAULT_CONVERGENCE_WINDOW);
            const since = new Date(
              Date.now() - days * 24 * 60 * 60 * 1000,
            ).toISOString();
            const productionCostCny = await repo.sumRunCostCny(since);
            const inWindow = cycles.filter((cycle) => cycle.createdAt >= since);
            const outcomeFile = await readOutcomeObservations();
            const divergence = divergenceGuard(
              buildDivergencePoints(cycles, outcomeFile.outcomes),
              { window: DEFAULT_DIVERGENCE_WINDOW },
            );
            const agreement = evaluatorAgreement(cycles, outcomeFile.outcomes);
            const governanceEvents = await loadGovernanceEvents(
              defaultGovernancePath(),
              10,
            );
            return {
              freeze,
              convergence: {
                window: guard.window,
                streak: guard.streak,
                wouldFreeze: guard.frozen,
                ...(guard.hint ? { hint: guard.hint } : {}),
              },
              cost: {
                since,
                ...evolutionCostReport(inWindow, productionCostCny),
              },
              outcome: {
                file: outcomeFile.path,
                corrupt: outcomeFile.corrupt,
                duplicates: outcomeFile.duplicates,
                summary: summarizeOutcomes(outcomeFile.outcomes),
                agreement,
                latest: outcomeFile.outcomes.slice(-5),
              },
              divergence,
              drift: cycles.find((cycle) => cycle.drift)?.drift ?? null,
              governanceEvents,
            };
          });
          emitResult(json, data);
        } catch (error) {
          reportError("status", error, json);
        }
      },
    );

  const outcome = evolve
    .command("outcome")
    .description("Outcome metrics from artifact acceptance or human review");

  outcome
    .command("record")
    .description("Record an acceptance/review outcome for a cycle or variant")
    .option("--cycle <id>", "evolution cycle the outcome judges")
    .option("--variant <id>", "variant whose output was reviewed")
    .requiredOption("--score <n>", "outcome score between 0 and 1")
    .option("--pass", "the artifact was accepted", false)
    .option("--fail", "the artifact was rejected", false)
    .option(
      "--source <source>",
      "artifact_acceptance | human_review",
      "human_review",
    )
    .option("--ref <id>", "artifact, review or incident reference")
    .option("--file <path>", "outcomes file", defaultOutcomesPath())
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        cycle?: string;
        variant?: string;
        score: string;
        pass: boolean;
        fail: boolean;
        source: string;
        ref?: string;
        file: string;
        json?: boolean;
      }) => {
        const json = wantsJson(options);
        const score = Number(options.score);
        if (!Number.isFinite(score) || score < 0 || score > 1) {
          emitError(
            json,
            new CliError("usage", "score must be between 0 and 1"),
          );
          return;
        }
        if (options.pass === options.fail) {
          emitError(
            json,
            new CliError("usage", "pass exactly one of --pass or --fail"),
          );
          return;
        }
        if (!options.cycle && !options.variant) {
          emitError(
            json,
            new CliError("usage", "an outcome needs --cycle or --variant"),
          );
          return;
        }
        if (
          options.source !== "artifact_acceptance" &&
          options.source !== "human_review"
        ) {
          emitError(
            json,
            new CliError(
              "usage",
              "source must be artifact_acceptance or human_review",
            ),
          );
          return;
        }
        try {
          const recorded = await recordOutcome(
            {
              score,
              pass: options.pass,
              source: options.source as OutcomeSource,
              ...(options.cycle ? { cycleId: options.cycle } : {}),
              ...(options.variant ? { variantId: options.variant } : {}),
              ...(options.ref ? { ref: options.ref } : {}),
            },
            options.file,
          );
          emitResult(json, recorded);
        } catch (error) {
          reportError("outcome record", error, json);
        }
      },
    );

  outcome
    .command("list")
    .description("List outcome observations and the agreement rate")
    .option("--limit <n>", "number of observations", "20")
    .option("--file <path>", "outcomes file", defaultOutcomesPath())
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { limit: string; file: string; json?: boolean }) => {
        const json = wantsJson(options);
        const limit = Math.max(1, Number(options.limit) || 20);
        const file = await readOutcomeObservations(options.file);
        const data = {
          file: file.path,
          corrupt: file.corrupt,
          duplicates: file.duplicates,
          summary: summarizeOutcomes(file.outcomes),
          outcomes: file.outcomes.slice(-limit),
        };
        emitResult(json, data);
      },
    );

  const snapshot = evolve
    .command("snapshot")
    .description("Inspect frozen eval snapshots");

  snapshot
    .command("verify <cycleId>")
    .description("Verify a frozen eval snapshot against its manifest")
    .option("--cycles-root <dir>", "external root for frozen eval snapshots")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        cycleId: string,
        options: { cyclesRoot?: string; json?: boolean },
      ) => {
        const json = wantsJson(options);
        try {
          const cyclesRoot = options.cyclesRoot ?? defaultCyclesRoot();
          const dir = path.join(cyclesRoot, cycleId, "eval");
          const verification = await verifyEvalSnapshot(dir);
          const data = { cycleId, dir, ...verification };
          emitResult(json, data);
          if (!verification.ok) {
            process.exitCode = 1;
          }
        } catch (error) {
          reportError("snapshot verify", error, json);
        }
      },
    );

  evolve
    .command("compare")
    .description("Compare latest scores per variant")
    .option("--json", "machine-readable output", false)
    .action(async (options: JsonFlag) => {
      const json = wantsJson(options);
      const variants = await withEvolutionRepo((repo) =>
        compareVariants(undefined, repo),
      );
      emitResult(json, variants);
    });

  evolve
    .command("promote <variantDir>")
    .description("Promote a variant into a target pack")
    .requiredOption("--target <dir>", "target pack directory")
    .option("--apply", "write changes (default is dry-run)", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (
        variantDir: string,
        options: { target: string; apply: boolean; json?: boolean },
      ) => {
        const json = wantsJson(options);
        try {
          const result = await withEvolutionRepo((repo) =>
            promoteVariant(variantDir, options.target, options.apply, repo),
          );
          emitResult(json, result);
        } catch (error) {
          reportError("promote", error, json);
        }
      },
    );
}

function emitResult(json: boolean, data: unknown): void {
  emit(json, data, () => {
    console.log(JSON.stringify(data, null, 2));
  });
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

function parseFreezeKind(value: string): EvolutionFreezeKind | null {
  return value === "incident" ||
    value === "manual" ||
    value === "convergence" ||
    value === "divergence"
    ? value
    : null;
}

function withIdempotencyKey<T extends object>(
  value: T,
  key: string | undefined,
): T | (T & { idempotencyKey: string }) {
  return key ? { ...value, idempotencyKey: key } : value;
}

function reportError(command: string, error: unknown, json = false): void {
  emitError(
    json,
    new CliError(
      "internal",
      `evolve ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Hidden suites default to `<KIT_HIDDEN_EVALS_ROOT or ~/.agent-team-kit/
 * hidden-evals>/<workspace>`. A missing directory means the cycle degrades to
 * the visible rubric and the manifest records `hidden.available: false`.
 */
function defaultHiddenDir(workspaceId: string): string | undefined {
  const dir = defaultHiddenEvalsDir(workspaceId);
  return existsSync(dir) ? dir : undefined;
}
