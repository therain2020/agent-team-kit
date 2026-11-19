import {
  CliError,
  type KillSwitchActorRole,
  type KillSwitchScope,
  killSwitchActorRoleSchema,
  killSwitchScopeSchema,
} from "@kit/core";
import {
  activateKillSwitch,
  listKillSwitches,
  releaseKillSwitch,
} from "@kit/engine";
import { initStore } from "@kit/store";
import type { Command } from "commander";
import { emit, emitError, wantsJson } from "../output";

interface ActivateOptions {
  scope: string;
  reason: string;
  target?: string;
  workspace?: string;
  actor: string;
  role: string;
  idempotencyKey?: string;
  json: boolean;
}

interface ReleaseOptions {
  reason: string;
  actor: string;
  role: string;
  idempotencyKey?: string;
  json: boolean;
}

export function registerKillSwitch(program: Command): void {
  const killSwitch = program
    .command("kill-switch")
    .description("Inspect, activate, and release kill switches");

  killSwitch
    .command("list")
    .description("List active and recent kill switches")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      await withStore(wantsJson(options), async (store) => {
        const state = await listKillSwitches(store);
        emit(wantsJson(options), state, () => {
          if (state.active.length === 0) {
            console.log("no active kill switches");
          } else {
            console.log("active:");
            for (const item of state.active) {
              console.log(
                `  ${item.switchId}  ${item.scope}/${item.target || "*"}  ${
                  item.reason
                }  by ${item.activatedBy}  v${item.version}`,
              );
            }
          }
          if (state.recent.length > 0) {
            console.log("recent:");
            for (const item of state.recent) {
              const released = item.releasedAt
                ? `  released ${item.releasedAt} by ${item.releasedBy}`
                : "";
              console.log(
                `  ${item.switchId}  ${item.state}  ${item.scope}/${
                  item.target || "*"
                }  ${item.reason}${released}`,
              );
            }
          }
        });
      });
    });

  killSwitch
    .command("activate")
    .description("Activate a kill switch")
    .requiredOption(
      "--scope <scope>",
      "global | workspace | agent-source | stage",
    )
    .requiredOption("--reason <reason>", "why this switch is needed")
    .option("--target <target>", "agent id or stage name")
    .option("--workspace <id>", "workspace id")
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option("--role <role>", "operator | security | agent | system", "operator")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(async (options: ActivateOptions) => {
      const json = wantsJson(options);
      let scope: KillSwitchScope;
      let role: KillSwitchActorRole;
      try {
        scope = parseScope(options.scope);
        role = parseRole(options.role);
      } catch (error) {
        emitError(
          json,
          new CliError(
            "usage",
            error instanceof Error ? error.message : String(error),
          ),
        );
        return;
      }
      await withStore(json, async (store) => {
        const activated = await activateKillSwitch(store, {
          scope,
          target: options.target,
          workspaceId: options.workspace,
          reason: options.reason,
          actor: options.actor,
          role,
        });
        emit(
          json,
          {
            ...activated,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
          () => {
            console.log(
              `activated ${activated.switchId}  ${activated.scope}/${
                activated.target || "*"
              }  v${activated.version}`,
            );
          },
        );
      });
    });

  killSwitch
    .command("release <switchId>")
    .description("Release an active kill switch")
    .requiredOption("--reason <reason>", "why the switch can be released")
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option("--role <role>", "operator | security | agent | system", "operator")
    .option(
      "--idempotency-key <key>",
      "caller-supplied key (no ledger yet; echoed for traceability)",
    )
    .option("--json", "machine-readable output", false)
    .action(async (switchId: string, options: ReleaseOptions) => {
      const json = wantsJson(options);
      let role: KillSwitchActorRole;
      try {
        role = parseRole(options.role);
      } catch (error) {
        emitError(
          json,
          new CliError(
            "usage",
            error instanceof Error ? error.message : String(error),
          ),
        );
        return;
      }
      await withStore(json, async (store) => {
        const released = await releaseKillSwitch(store, {
          switchId,
          reason: options.reason,
          actor: options.actor,
          role,
        });
        emit(
          json,
          {
            ...released,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          },
          () => {
            console.log(
              `released ${released.switchId}  ${released.scope}/${
                released.target || "*"
              }  v${released.version}`,
            );
          },
        );
      });
    });
}

function parseScope(value: string): KillSwitchScope {
  const parsed = killSwitchScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      "usage",
      "scope must be global, workspace, agent-source, or stage",
    );
  }
  return parsed.data;
}

function parseRole(value: string | undefined): KillSwitchActorRole {
  const parsed = killSwitchActorRoleSchema.safeParse(value ?? "operator");
  if (!parsed.success) {
    throw new CliError(
      "usage",
      "role must be operator, security, agent, or system",
    );
  }
  return parsed.data;
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
    emitError(json, error);
  } finally {
    await store.close();
  }
}
