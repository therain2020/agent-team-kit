import { type ActivityInput, appendActivity } from "@kit/activity";
import {
  type KillSwitch,
  type KillSwitchActorRole,
  type KillSwitchCheckpoint,
  type KillSwitchContext,
  type KillSwitchScope,
  KillSwitchTrippedError,
  assertKillSwitchPermission,
  killSwitchSchema,
  newId,
  normalizeKillSwitchIdentity,
  resolveKillSwitch,
} from "@kit/core";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

async function safeActivity(store: Store, input: ActivityInput): Promise<void> {
  try {
    await appendActivity(store, input);
  } catch (error) {
    console.error(
      `[kill-switch] failed to write audit event: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function activeKillSwitchFor(
  store: Store,
  context: KillSwitchContext,
): Promise<KillSwitch | null> {
  const active = await store.killSwitches.listActive();
  return resolveKillSwitch(active, context);
}

export async function assertKillSwitchClear(
  store: Store,
  context: KillSwitchContext,
  checkpoint: KillSwitchCheckpoint,
): Promise<void> {
  const hit = await activeKillSwitchFor(store, context);
  if (!hit) {
    return;
  }
  await safeActivity(store, {
    workspaceId: context.workspaceId,
    kind: "kill_switch.tripped",
    status: "blocked",
    summary: `${hit.scope}/${hit.target || "*"} blocked ${checkpoint}`,
    payload: {
      checkpoint,
      switchId: hit.switchId,
      scope: hit.scope,
      target: hit.target,
      reason: hit.reason,
      agentId: context.agentId ?? null,
      stageId: context.stageId ?? null,
      stageName: context.stageName ?? null,
    },
  });
  throw new KillSwitchTrippedError(hit, checkpoint);
}

export interface ActivateKillSwitchInput {
  scope: KillSwitchScope;
  target?: string | null;
  workspaceId?: string | null;
  reason: string;
  actor: string;
  role: KillSwitchActorRole;
}

export async function activateKillSwitch(
  store: Store,
  input: ActivateKillSwitchInput,
): Promise<KillSwitch> {
  assertKillSwitchPermission(input.scope, input.role);
  const identity = normalizeKillSwitchIdentity(input);
  const now = new Date().toISOString();
  const draft = killSwitchSchema.parse({
    switchId: newId("kill"),
    scope: input.scope,
    target: identity.target,
    workspaceId: identity.workspaceId,
    state: "active",
    activatedBy: input.actor,
    reason: input.reason,
    activatedAt: now,
    releasedBy: null,
    releasedAt: null,
    releaseReason: null,
    version: 1,
    updatedAt: now,
  });

  const result = await store.killSwitches.activate(draft);
  if (result.changed) {
    await safeActivity(store, {
      workspaceId: identity.workspaceId ?? "default",
      kind: "kill_switch.activated",
      status: "active",
      summary: `${draft.scope}/${draft.target || "*"}: ${draft.reason}`,
      payload: {
        switchId: result.record.switchId,
        scope: result.record.scope,
        target: result.record.target,
        workspaceId: result.record.workspaceId,
        reason: result.record.reason,
        actor: input.actor,
        role: input.role,
        version: result.record.version,
      },
    });
  }
  return result.record;
}

export interface ReleaseKillSwitchInput {
  switchId: string;
  reason: string;
  actor: string;
  role: KillSwitchActorRole;
}

export async function releaseKillSwitch(
  store: Store,
  input: ReleaseKillSwitchInput,
): Promise<KillSwitch> {
  const current = await store.killSwitches.get(input.switchId);
  if (!current) {
    throw new Error(`kill switch not found: ${input.switchId}`);
  }
  assertKillSwitchPermission(current.scope, input.role);
  const now = new Date().toISOString();
  const result = await store.killSwitches.release(
    input.switchId,
    input.actor,
    input.reason,
    now,
  );
  if (!result) {
    throw new Error(`kill switch not found: ${input.switchId}`);
  }
  if (result.changed) {
    await safeActivity(store, {
      workspaceId: result.record.workspaceId ?? "default",
      kind: "kill_switch.released",
      status: "released",
      summary: `${result.record.scope}/${result.record.target || "*"}: ${
        input.reason
      }`,
      payload: {
        switchId: result.record.switchId,
        scope: result.record.scope,
        target: result.record.target,
        workspaceId: result.record.workspaceId,
        reason: input.reason,
        actor: input.actor,
        role: input.role,
        version: result.record.version,
      },
    });
  }
  return result.record;
}

export async function listKillSwitches(
  store: Store,
  limit = 50,
): Promise<{ active: KillSwitch[]; recent: KillSwitch[] }> {
  const [active, recent] = await Promise.all([
    store.killSwitches.listActive(),
    store.killSwitches.list(limit),
  ]);
  return { active, recent };
}
