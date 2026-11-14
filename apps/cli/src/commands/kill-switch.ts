import {
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

interface ActivateOptions {
  scope: string;
  reason: string;
  target?: string;
  workspace?: string;
  actor: string;
  role: string;
}

interface ReleaseOptions {
  reason: string;
  actor: string;
  role: string;
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
      await withStore(async (store) => {
        const state = await listKillSwitches(store);
        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
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
    .action(async (options: ActivateOptions) => {
      const scope = parseScope(options.scope);
      const role = parseRole(options.role);
      await withStore(async (store) => {
        const activated = await activateKillSwitch(store, {
          scope,
          target: options.target,
          workspaceId: options.workspace,
          reason: options.reason,
          actor: options.actor,
          role,
        });
        console.log(
          `activated ${activated.switchId}  ${activated.scope}/${
            activated.target || "*"
          }  v${activated.version}`,
        );
      });
    });

  killSwitch
    .command("release <switchId>")
    .description("Release an active kill switch")
    .requiredOption("--reason <reason>", "why the switch can be released")
    .option("--actor <actor>", "operator identity", "operator:cli")
    .option("--role <role>", "operator | security | agent | system", "operator")
    .action(async (switchId: string, options: ReleaseOptions) => {
      const role = parseRole(options.role);
      await withStore(async (store) => {
        const released = await releaseKillSwitch(store, {
          switchId,
          reason: options.reason,
          actor: options.actor,
          role,
        });
        console.log(
          `released ${released.switchId}  ${released.scope}/${
            released.target || "*"
          }  v${released.version}`,
        );
      });
    });
}

function parseScope(value: string): KillSwitchScope {
  const parsed = killSwitchScopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("scope must be global, workspace, agent-source, or stage");
  }
  return parsed.data;
}

function parseRole(value: string | undefined): KillSwitchActorRole {
  const parsed = killSwitchActorRoleSchema.safeParse(value ?? "operator");
  if (!parsed.success) {
    throw new Error("role must be operator, security, agent, or system");
  }
  return parsed.data;
}

async function withStore(
  run: (store: Awaited<ReturnType<typeof initStore>>) => Promise<void>,
): Promise<void> {
  let store: Awaited<ReturnType<typeof initStore>>;
  try {
    store = await initStore();
  } catch (error) {
    console.error("✖ cannot reach the kit database");
    console.error(
      `  ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    await run(store);
  } catch (error) {
    console.error(
      `✖ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}
