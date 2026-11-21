import path from "node:path";
import { CliError, draftReactionRule } from "@kit/core";
import { initStore } from "@kit/store";
import {
  loadTriggerUsage,
  reactToInformationEvent,
  traceReactions,
} from "@kit/trigger";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface ReactionSetOptions {
  rule?: string;
  name?: string;
  eventType: string;
  topics?: string;
  entities?: string;
  relevance?: string;
  novelty?: string;
  urgency?: string;
  pack: string;
  workflow?: string;
  goal?: string;
  mission?: string;
  jobKind: "packRun" | "iteration";
  runMode: "DRY_RUN" | "LIVE";
  priority: string;
  dailyRuns?: string;
  dailyCost?: string;
  enabled?: boolean;
  disabled?: boolean;
  expectedVersion?: string;
  rationale: string;
  json?: boolean;
}

export function registerReaction(program: Command): void {
  const reaction = program
    .command("reaction")
    .description("ReactionRules that turn information events into jobs");

  reaction
    .command("list")
    .description("List current rules with today's per-rule usage")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const rules = await store.reactionRules.listCurrent();
        const now = new Date();
        const rows: Array<Record<string, unknown>> = [];
        for (const rule of rules) {
          const usage = await loadTriggerUsage(
            store,
            "default",
            { triggerId: `information:${rule.ruleId}` },
            now,
            rule.budget?.dailyCostCny !== undefined,
          );
          rows.push({
            ruleId: rule.ruleId,
            version: rule.version,
            enabled: rule.enabled,
            priority: rule.priority,
            match: rule.match,
            target: rule.target,
            runMode: rule.runMode,
            budget: rule.budget ?? null,
            usage,
          });
        }
        emit(json, { rules: rows }, () => {
          if (rows.length === 0) {
            console.log(
              "No reaction rules. Create one: kit reaction set --name <name> --pack <dir> --workflow <id> --rationale <sentence>",
            );
            return;
          }
          for (const row of rows) {
            const budget = (row.budget ?? {}) as {
              dailyRuns?: number;
              dailyCostCny?: number;
            };
            const usage = row.usage as { runs: number; costCny: number };
            console.log(
              `${row.ruleId}  v${row.version}  ${row.enabled ? "enabled " : "disabled"}  p${row.priority}  ${usage.runs}/${budget.dailyRuns ?? "∞"} runs today  ${usage.costCny}/${budget.dailyCostCny ?? "∞"} CNY`,
            );
          }
        });
      } catch (error) {
        report("list", error, json);
      } finally {
        await store.close();
      }
    });

  reaction
    .command("propose")
    .description(
      "Turn one sentence into a heuristic rule draft (no side effects)",
    )
    .requiredOption("--intent <text>", "what should trigger which job")
    .option("--rule <id>", "existing rule to start from for a re-proposal")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { intent: string; rule?: string; json?: boolean }) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const base = options.rule
            ? await store.reactionRules.getCurrent("default", options.rule)
            : null;
          const draft = draftReactionRule(options.intent, base);
          emit(json, draft, () => {
            console.log(JSON.stringify(draft, null, 2));
            console.log(
              "\nDraft only; nothing was saved. Review it, then run `kit reaction set ... --rationale <sentence>`.",
            );
          });
        } catch (error) {
          report("propose", error, json);
        } finally {
          await store.close();
        }
      },
    );

  reaction
    .command("set")
    .description("Create or update a rule (observer edit; appends a version)")
    .option("--rule <id>", "existing rule id; omit to create")
    .option("--name <name>", "rule name")
    .option("--event-type <type>", "event type pattern", "information.*")
    .option("--topics <list>", "comma-separated any-of topics")
    .option("--entities <list>", "comma-separated any-of entities")
    .option("--relevance <n>", "minimum relevance 0..1")
    .option("--novelty <n>", "minimum novelty 0..1")
    .option("--urgency <n>", "minimum urgency 0..1")
    .option("--pack <dir>", "target pack directory")
    .option("--workflow <id>", "target workflow (packRun)")
    .option("--goal <text>", "target goal (iteration)")
    .option("--mission <text>", "mission template, e.g. 'React to {title}'")
    .option("--job-kind <kind>", "packRun|iteration", "packRun")
    .option("--run-mode <mode>", "DRY_RUN|LIVE", "DRY_RUN")
    .option("--priority <n>", "higher reacts first", "0")
    .option("--daily-runs <n>", "per-rule daily run budget")
    .option("--daily-cost <cny>", "per-rule daily cost budget")
    .option("--enabled", "enable the rule", false)
    .option("--disabled", "disable the rule", false)
    .option("--expected-version <n>", "reject if the current version differs")
    .requiredOption("--rationale <text>", "one sentence explaining the change")
    .option("--json", "machine-readable output", false)
    .action(async (options: ReactionSetOptions) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const current = options.rule
          ? await store.reactionRules.getCurrent("default", options.rule)
          : null;
        if (options.rule && !current) {
          throw new CliError("not_found", "reaction rule not found");
        }
        const jobKind =
          options.jobKind === "iteration" ? "iteration" : "packRun";
        if (!options.pack) {
          throw new CliError("usage", "--pack is required");
        }
        if (jobKind === "packRun" && !options.workflow) {
          throw new CliError("usage", "--workflow is required for packRun");
        }
        if (jobKind === "iteration" && !options.goal) {
          throw new CliError("usage", "--goal is required for iteration");
        }
        const expectedVersion = parseOptionalInt(options.expectedVersion);
        const enabled = options.disabled
          ? false
          : options.enabled
            ? true
            : (current?.enabled ?? true);
        const budget = buildBudget(options) ?? current?.budget;
        const saved = await store.reactionRules.saveRule(
          {
            ...(options.rule ? { ruleId: options.rule } : {}),
            name: options.name ?? current?.name ?? options.rule ?? "reaction",
            enabled,
            match: {
              eventType: options.eventType,
              topics: parseList(options.topics),
              entities: parseList(options.entities),
              minSignals: {
                ...(options.relevance !== undefined
                  ? { relevance: parseRatio(options.relevance, "--relevance") }
                  : {}),
                ...(options.novelty !== undefined
                  ? { novelty: parseRatio(options.novelty, "--novelty") }
                  : {}),
                ...(options.urgency !== undefined
                  ? { urgency: parseRatio(options.urgency, "--urgency") }
                  : {}),
              },
            },
            target: {
              packDir: options.pack,
              jobKind,
              ...(options.workflow ? { workflow: options.workflow } : {}),
              ...(options.goal ? { goal: options.goal } : {}),
            },
            ...(options.mission
              ? { missionTemplate: options.mission }
              : current?.missionTemplate
                ? { missionTemplate: current.missionTemplate }
                : {}),
            runMode: options.runMode,
            ...(budget ? { budget } : {}),
            approval: current?.approval ?? {
              autoApprove: true,
              maxRisk: "low",
            },
            priority: parseInteger(options.priority, "--priority"),
            source: "human",
            rationale: options.rationale,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          },
          { actor: "operator:cli" },
        );
        emit(json, { rule: saved }, () => {
          console.log(
            `✔ reaction rule ${saved.ruleId} v${saved.version} saved (${saved.enabled ? "enabled" : "disabled"})`,
          );
          console.log(
            `  match: ${saved.match.eventType} topics=${saved.match.topics.join(",") || "—"} entities=${saved.match.entities.join(",") || "—"}`,
          );
          console.log(
            `  target: ${saved.target.packDir}/${saved.target.workflow ?? saved.target.goal ?? "?"} (${saved.runMode})`,
          );
          console.log(`  rationale: ${saved.rationale}`);
        });
      } catch (error) {
        report("set", error, json);
      } finally {
        await store.close();
      }
    });

  reaction
    .command("enable <ruleId>")
    .description("Enable a rule (observer edit; appends a version)")
    .requiredOption("--rationale <text>", "one sentence explaining the change")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        ruleId: string,
        options: { rationale: string; json?: boolean },
      ) => {
        await toggle(ruleId, true, options);
      },
    );

  reaction
    .command("disable <ruleId>")
    .description("Disable a rule (observer edit; appends a version)")
    .requiredOption("--rationale <text>", "one sentence explaining the change")
    .option("--json", "machine-readable output", false)
    .action(
      async (
        ruleId: string,
        options: { rationale: string; json?: boolean },
      ) => {
        await toggle(ruleId, false, options);
      },
    );

  reaction
    .command("run")
    .description("Match one stored information event and dispatch its rules")
    .requiredOption("--event <eventId>", "information event id")
    .option("--max <n>", "hard cap of rules fired for this event")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { event: string; max?: string; json?: boolean }) => {
        const json = wantsJson(options);
        const store = await initStore();
        try {
          const event = await store.information.getEvent(
            "default",
            options.event,
          );
          if (!event) {
            throw new CliError("not_found", "information event not found");
          }
          const rules = await store.reactionRules.listCurrent();
          const max = options.max
            ? parseInteger(options.max, "--max")
            : undefined;
          const outcome = await reactToInformationEvent(event, {
            store,
            repoRoot: path.resolve(process.cwd()),
            workspaceId: "default",
            rules,
            ...(max !== undefined ? { maxReactions: max } : {}),
          });
          emit(json, outcome, () => {
            for (const candidate of outcome.candidates) {
              console.log(
                `${candidate.decision.padEnd(16)} ${candidate.ruleId}  ${candidate.jobId ?? "-"}  ${candidate.reason ?? ""}`.trim(),
              );
              for (const reason of candidate.reasons) {
                console.log(`    · ${reason}`);
              }
            }
            console.log(
              `total: ${outcome.fired} fired / ${outcome.existing} existing / ${outcome.skipped} skipped / ${outcome.failed} failed`,
            );
          });
        } catch (error) {
          report("run", error, json);
        } finally {
          await store.close();
        }
      },
    );

  reaction
    .command("trace")
    .description("Trace an information event to its rules and jobs")
    .requiredOption("--event <eventId>", "information event id")
    .option("--json", "machine-readable output", false)
    .action(async (options: { event: string; json?: boolean }) => {
      const json = wantsJson(options);
      const store = await initStore();
      try {
        const rows = await traceReactions({ store }, "default", options.event);
        emit(json, { eventId: options.event, reactions: rows }, () => {
          if (rows.length === 0) {
            console.log(`No reactions for ${options.event}.`);
            return;
          }
          for (const row of rows) {
            console.log(
              `${row.ruleId ?? "?"}  ${row.status.padEnd(8)}  job=${row.jobId ?? "-"}  triggerRun=${row.triggerRunId}  ${row.launchedAt}`,
            );
            console.log(
              `  artifacts=${row.artifacts.map((item) => item.artifactId).join(",") || "-"}  decisions=${row.decisions.map((item) => item.ref).join(",") || "-"}  rollback=${row.rollbacks.map((item) => item.ref).join(",") || "-"}  chain=${row.chainComplete ? "complete" : "incomplete"}`,
            );
          }
        });
      } catch (error) {
        report("trace", error, json);
      } finally {
        await store.close();
      }
    });
}

async function toggle(
  ruleId: string,
  enabled: boolean,
  options: { rationale: string; json?: boolean },
): Promise<void> {
  const json = wantsJson(options);
  const store = await initStore();
  try {
    const saved = await store.reactionRules.setEnabled({
      ruleId,
      enabled,
      rationale: options.rationale,
      actor: "operator:cli",
    });
    emit(json, { rule: saved }, () => {
      console.log(
        `✔ reaction rule ${saved.ruleId} v${saved.version} ${enabled ? "enabled" : "disabled"}`,
      );
    });
  } catch (error) {
    report(enabled ? "enable" : "disable", error, json);
  } finally {
    await store.close();
  }
}

function buildBudget(
  options: ReactionSetOptions,
): { dailyRuns?: number; dailyCostCny?: number } | undefined {
  const dailyRuns =
    options.dailyRuns !== undefined
      ? parseInteger(options.dailyRuns, "--daily-runs")
      : undefined;
  const dailyCostCny =
    options.dailyCost !== undefined
      ? parseNonNegative(options.dailyCost, "--daily-cost")
      : undefined;
  if (dailyRuns === undefined && dailyCostCny === undefined) {
    return undefined;
  }
  return {
    ...(dailyRuns !== undefined ? { dailyRuns } : {}),
    ...(dailyCostCny !== undefined ? { dailyCostCny } : {}),
  };
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRatio(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError("usage", `${label} must be between 0 and 1`);
  }
  return parsed;
}

function parseNonNegative(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError("usage", `${label} must be a non-negative number`);
  }
  return parsed;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError("usage", `${label} must be an integer`);
  }
  return parsed;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(
      "usage",
      "--expected-version must be a non-negative integer",
    );
  }
  return parsed;
}

function report(command: string, error: unknown, json: boolean): void {
  emitError(
    json,
    new CliError(
      "internal",
      `reaction ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}
