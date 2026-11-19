import { CliError } from "@kit/core";
import {
  type AutonomyPresetConfigInput,
  DEFAULT_WORKSPACE_ID,
  enableAutonomyPreset,
  getActiveAutonomyPreset,
  getOpsGate,
  parseAutonomyPresetConfig,
  rollbackAutonomyPreset,
} from "@kit/ops";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface StatusOptions {
  workspace?: string;
  json?: boolean;
}

interface EnableOptions {
  applyMode?: string;
  dailyCostCny?: string;
  dailyRuns?: string;
  maxTasks?: string;
  allowNight?: boolean;
  actor?: string;
  reason?: string;
  workspace?: string;
  idempotencyKey?: string;
  json?: boolean;
}

interface RollbackOptions {
  actor?: string;
  reason?: string;
  workspace?: string;
  idempotencyKey?: string;
  json?: boolean;
}

export function registerAutonomy(program: Command): void {
  const autonomy = program
    .command("autonomy")
    .description(
      "Inspect, enable, and roll back the self-hosted LIVE autonomy preset",
    );

  autonomy
    .command("status")
    .description("Show the current autonomy level and enabling evidence")
    .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
    .option("--json", "print JSON")
    .action(async (options: StatusOptions) => {
      const json = wantsJson(options);
      const workspaceId = options.workspace ?? DEFAULT_WORKSPACE_ID;
      await withStore(json, async (store) => {
        const preset = await getActiveAutonomyPreset(store, workspaceId);
        const gate = await getOpsGate(store, new Date(), workspaceId);
        const data = {
          level: preset ? preset.level : "manual",
          preset,
          gate,
          liveAllowed: process.env.KIT_UI_ALLOW_LIVE === "1" || preset !== null,
        };
        emit(json, data, () => {
          if (!preset) {
            console.log("autonomy level: manual (factory default)");
            console.log("preset: none");
            console.log(
              `LIVE gate: ${
                process.env.KIT_UI_ALLOW_LIVE === "1"
                  ? "open (KIT_UI_ALLOW_LIVE=1)"
                  : "closed (run `kit autonomy enable` or set KIT_UI_ALLOW_LIVE=1)"
              }`,
            );
            printGate(gate);
            return;
          }
          console.log(`autonomy level: ${preset.level}`);
          console.log(`preset: ${preset.presetId} (${preset.status})`);
          console.log(`applied: ${preset.appliedAt} by ${preset.appliedBy}`);
          console.log(`apply mode: ${preset.config.applyMode}`);
          console.log(
            `budget: ${preset.config.dailyCostCny} CNY/day, ${preset.config.dailyRuns} runs/day`,
          );
          console.log(`max tasks: ${preset.config.maxTasks}`);
          console.log(
            `night exception: ${preset.config.allowNight ? "on" : "off"}`,
          );
          console.log("LIVE gate: open (preset active)");
          printGate(gate);
        });
      });
    });

  autonomy
    .command("enable")
    .description(
      "Enable the self-hosted LIVE preset: unattended LIVE iterations with a budget cap",
    )
    .option("--apply-mode <mode>", "low | low-medium", "low-medium")
    .option("--daily-cost-cny <cny>", "daily cost cap in CNY", "5")
    .option("--daily-runs <runs>", "daily run cap", "2")
    .option("--max-tasks <tasks>", "max tasks per iteration", "2")
    .option("--no-allow-night", "keep night mode read-only")
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option("--reason <reason>", "why the preset is enabled")
    .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "print JSON")
    .action(async (options: EnableOptions) => {
      const json = wantsJson(options);
      let config: AutonomyPresetConfigInput;
      try {
        config = parseEnableOptions(options);
      } catch (error) {
        emitError(json, new CliError("usage", classifyMessage(error)));
        return;
      }
      const workspaceId = options.workspace ?? DEFAULT_WORKSPACE_ID;
      await withStore(json, async (store) => {
        const preset = await enableAutonomyPreset(store, {
          config,
          actor: options.actor,
          reason: options.reason,
          workspaceId,
        });
        emit(
          json,
          {
            level: preset.level,
            preset,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey, idempotent: false }
              : {}),
          },
          () => {
            console.log(
              `enabled ${preset.presetId}: ${preset.level} · apply ${preset.config.applyMode} · ${preset.config.dailyCostCny} CNY/day`,
            );
            console.log(
              `night exception: ${preset.config.allowNight ? "on" : "off"} · audit: ops.autonomy.enabled`,
            );
            console.log("rollback: kit autonomy rollback");
          },
        );
      });
    });

  autonomy
    .command("rollback")
    .description(
      "Roll back the preset and restore the factory-default autonomy level",
    )
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option("--reason <reason>", "why the preset is rolled back")
    .option("--workspace <id>", "workspace id", DEFAULT_WORKSPACE_ID)
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "print JSON")
    .action(async (options: RollbackOptions) => {
      const json = wantsJson(options);
      const workspaceId = options.workspace ?? DEFAULT_WORKSPACE_ID;
      await withStore(json, async (store) => {
        const preset = await rollbackAutonomyPreset(store, {
          actor: options.actor,
          reason: options.reason,
          workspaceId,
        });
        emit(
          json,
          {
            level: "manual",
            preset,
            rolledBack: preset !== null,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
          () => {
            if (!preset) {
              console.log("autonomy level already manual: no active preset");
              return;
            }
            console.log(
              `rolled back ${preset.presetId} at ${preset.rolledBackAt} by ${preset.rolledBackBy}`,
            );
            console.log("autonomy level: manual (factory default)");
            console.log("audit: ops.autonomy.rolled_back");
          },
        );
      });
    });
}

function parseEnableOptions(options: EnableOptions): AutonomyPresetConfigInput {
  return parseAutonomyPresetConfig({
    applyMode: options.applyMode,
    dailyCostCny: parseNumber(options.dailyCostCny, "daily-cost-cny"),
    dailyRuns: parseNumber(options.dailyRuns, "daily-runs"),
    maxTasks: parseNumber(options.maxTasks, "max-tasks"),
    allowNight: options.allowNight !== false,
  });
}

function parseNumber(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === "") {
    throw new Error(`--${name} must be a number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }
  return parsed;
}

function printGate(gate: Awaited<ReturnType<typeof getOpsGate>>): void {
  if (!gate.nightMode) {
    console.log(`gate: open (${gate.timezone ?? "unknown timezone"})`);
    return;
  }
  console.log(
    `gate: night mode${gate.nightException ? " exception active" : " read-only"} · ${gate.reason ?? ""}`,
  );
}

async function withStore(
  json: boolean,
  run: (store: Awaited<ReturnType<typeof initStore>>) => Promise<void>,
): Promise<void> {
  let store: Awaited<ReturnType<typeof initStore>>;
  try {
    store = await initStore();
  } catch (error) {
    emitError(
      json,
      new CliError("dependency_unavailable", "cannot reach the kit database", {
        hint: "start the stack with `kit up`, or point KIT_DB_URL at a running Postgres",
        details: {
          detail: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return;
  }
  try {
    await run(store);
  } catch (error) {
    emitError(
      json,
      new CliError(
        "internal",
        error instanceof Error ? error.message : String(error),
      ),
    );
  } finally {
    await store.close();
  }
}

function classifyMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
