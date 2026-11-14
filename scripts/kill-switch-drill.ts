#!/usr/bin/env bun
import {
  type KillSwitchCheckpoint,
  type KillSwitchContext,
  type KillSwitchScope,
  KillSwitchTrippedError,
} from "@kit/core";
import {
  activateKillSwitch,
  assertKillSwitchClear,
  releaseKillSwitch,
} from "@kit/engine";
import { initStore } from "@kit/store";

interface DrillCase {
  scope: KillSwitchScope;
  target?: string;
  workspaceId?: string;
  context: KillSwitchContext;
  clearContext: KillSwitchContext | null;
}

const execute = process.argv.includes("--execute");
const workspaceId = process.env.KIT_DRILL_WORKSPACE ?? "default";
const reason = process.env.KIT_DRILL_REASON ?? "kill switch drill";

const cases: DrillCase[] = [
  {
    scope: "global",
    context: { workspaceId },
    clearContext: null,
  },
  {
    scope: "workspace",
    workspaceId,
    context: { workspaceId },
    clearContext: { workspaceId: "drill-other" },
  },
  {
    scope: "agent-source",
    target: "drill-agent",
    context: { workspaceId, agentId: "drill-agent" },
    clearContext: { workspaceId, agentId: "drill-reviewer" },
  },
  {
    scope: "stage",
    target: "drill-stage",
    context: { workspaceId, stageName: "drill-stage" },
    clearContext: { workspaceId, stageName: "drill-other" },
  },
];

if (!execute) {
  console.log(
    "dry run (pass --execute to write activation/release audit records)",
  );
  for (const item of cases) {
    console.log(
      `  ${item.scope}/${item.target ?? "*"}  workspace=${item.workspaceId ?? workspaceId}`,
    );
  }
  process.exit(0);
}

function checkpointFor(scope: KillSwitchScope): KillSwitchCheckpoint {
  return scope === "global" ? "run" : "stage";
}

const store = await initStore();
let failed = false;

try {
  for (const item of cases) {
    const activated = await activateKillSwitch(store, {
      scope: item.scope,
      target: item.target,
      workspaceId: item.workspaceId,
      reason,
      actor: "operator:drill",
      role: "operator",
    });

    const blocked = await trips(store, item.context, checkpointFor(item.scope));
    const clear = item.clearContext
      ? !(await trips(store, item.clearContext, checkpointFor(item.scope)))
      : true;

    await releaseKillSwitch(store, {
      switchId: activated.switchId,
      reason: `${reason} complete`,
      actor: "operator:drill",
      role: "operator",
    });
    const released = !(await trips(
      store,
      item.context,
      checkpointFor(item.scope),
    ));

    const ok = blocked && clear && released;
    failed ||= !ok;
    console.log(
      `${ok ? "ok" : "FAIL"}  ${item.scope}/${item.target ?? "*"}  blocked=${blocked} isolated=${clear} released=${released}`,
    );
  }
} finally {
  await store.close();
}

if (failed) {
  process.exitCode = 1;
  console.error("kill switch drill failed");
} else {
  console.log(
    "kill switch drill passed; activation/release/trip audit records written",
  );
}

async function trips(
  store: Awaited<ReturnType<typeof initStore>>,
  context: KillSwitchContext,
  checkpoint: KillSwitchCheckpoint,
): Promise<boolean> {
  try {
    await assertKillSwitchClear(store, context, checkpoint);
    return false;
  } catch (error) {
    if (error instanceof KillSwitchTrippedError) {
      return true;
    }
    throw error;
  }
}
