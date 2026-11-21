import {
  ObserverActionError,
  type ObserverActionRecord,
  type ObserverActionType,
  type ObserverMetrics,
  type ObserverTimelineEntry,
  appendActivity,
  buildObserverTimeline,
  isObserverActionType,
  isProtectedEditTarget,
  listObserverActions,
  recordObserverAction,
  summarizeObserverMetrics,
} from "@kit/activity";
import {
  type KillSwitchScope,
  killSwitchScopeSchema,
  selectLastKnownGood,
} from "@kit/core";
import { activateKillSwitch } from "@kit/engine";
import { enterMode } from "./degradation";
import {
  type SaveProfileRequestBody,
  parseSaveProfileBody,
  saveProfile,
} from "./information";
import { ensureStoreSchema, getStore } from "./store";

/**
 * Observer surface server reads and the single controlled intervention path
 * (98 §3.5, issue #134).
 *
 * Reads are side-effect free. Every intervention reuses the plane that already
 * owns the effect — read-only degradation for pause, the kill-switch service
 * for kill, the LKG service for rollback, the interest-profile store for edit —
 * and then records one observer action in the shared audit. The observer never
 * writes a job, artifact or recovery-kernel state directly.
 */

type Store = ReturnType<typeof getStore>;

export interface GateApprovalRef {
  approvalId: string;
  kind: string;
  status: string;
  createdAt: string;
  decisionAt: string | null;
  href: string;
}

export interface ObserverView {
  workspaceId: string;
  timeline: ObserverTimelineEntry[];
  actions: ObserverActionRecord[];
  metrics: ObserverMetrics;
  gateApprovals: GateApprovalRef[];
  editHref: string;
}

export interface ParsedIntervention {
  type: ObserverActionType;
  actor: string;
  reason: string;
  targetRef: string;
  reference?: string;
  workspaceId: string;
  scope?: KillSwitchScope;
  profile?: SaveProfileRequestBody;
}

export interface InterventionResult {
  action: ObserverActionRecord;
  detail: Record<string, unknown>;
}

export const DEFAULT_OBSERVER_WORKSPACE = "default";

export async function loadObserverView(
  workspaceId = DEFAULT_OBSERVER_WORKSPACE,
): Promise<ObserverView> {
  await ensureStoreSchema();
  const store = getStore();
  const [timeline, actions, metrics, approvalPage] = await Promise.all([
    buildObserverTimeline(store, { workspaceId, limit: 20 }),
    listObserverActions(store, { workspaceId, limit: 30 }),
    summarizeObserverMetrics(store, { workspaceId }),
    store.approvals
      .list({ workspaceId, limit: 20, sort: "created" })
      .catch(() => null),
  ]);

  return {
    workspaceId,
    timeline,
    actions,
    metrics,
    gateApprovals: (approvalPage?.items ?? [])
      .filter(
        (item) => item.kind === "stage_before" || item.kind === "gate_failure",
      )
      .map((item) => ({
        approvalId: item.approvalId,
        kind: item.kind,
        status: item.status,
        createdAt: item.createdAt,
        decisionAt: item.decisionAt,
        href: `/approvals?request=${encodeURIComponent(item.approvalId)}`,
      })),
    editHref: "/world?tab=information",
  };
}

/** Validate the JSON body of `POST /api/observer/interventions`. */
export function parseInterventionBody(body: unknown): ParsedIntervention {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ObserverActionError("invalid JSON body", "invalid", 400);
  }
  const record = body as Record<string, unknown>;
  const requestedType = record.type;
  if (!isObserverActionType(requestedType)) {
    throw new ObserverActionError(
      `forbidden observer action: ${String(requestedType)}`,
      "forbidden",
      403,
    );
  }
  const type = requestedType;
  const workspaceId =
    nonEmpty(record.workspaceId) ?? DEFAULT_OBSERVER_WORKSPACE;
  const reason = nonEmpty(record.reason);
  if (!reason) {
    throw new ObserverActionError("a reason is required", "invalid", 400);
  }
  const actor = nonEmpty(record.actor) ?? "operator:web";

  const scope = type === "kill" ? parseScope(record.scope) : undefined;
  const targetRef =
    nonEmpty(record.targetRef) ?? defaultTarget(type, workspaceId, scope);
  if (!targetRef) {
    throw new ObserverActionError("targetRef is required", "invalid", 400);
  }
  if (type === "edit" && isProtectedEditTarget(targetRef)) {
    throw new ObserverActionError(
      `${targetRef} is safety infrastructure and cannot be edited`,
      "forbidden",
      403,
    );
  }

  const reference = nonEmpty(record.reference) ?? undefined;

  let profile: SaveProfileRequestBody | undefined;
  if (type === "edit") {
    if (!record.profile || typeof record.profile !== "object") {
      throw new ObserverActionError(
        "edit requires a profile payload",
        "invalid",
        400,
      );
    }
    profile = parseSaveProfileBody({
      ...(record.profile as Record<string, unknown>),
      updatedBy: "human",
    });
  }

  return {
    type,
    actor,
    reason: reason.slice(0, 2000),
    targetRef,
    ...(reference ? { reference } : {}),
    workspaceId,
    ...(scope ? { scope } : {}),
    ...(profile ? { profile } : {}),
  };
}

/** Execute one intervention, then write its audit; any failure aborts mid-way. */
export async function runIntervention(
  input: ParsedIntervention,
): Promise<InterventionResult> {
  await ensureStoreSchema();
  const store = getStore();
  let reference = input.reference ?? null;
  let detail: Record<string, unknown> = {};

  switch (input.type) {
    case "pause": {
      const mode = await enterMode({
        scope: "workspace",
        workspaceId: input.workspaceId,
        kind: "read_only",
        dependencyId: "event_bus",
        reason: input.reason,
      });
      detail = { modeId: mode.modeId };
      break;
    }
    case "kill": {
      const scope = input.scope ?? "workspace";
      const killSwitch = await activateKillSwitch(store, {
        scope,
        target:
          scope === "global"
            ? undefined
            : scope === "workspace"
              ? input.workspaceId
              : input.targetRef,
        workspaceId: scope === "global" ? undefined : input.workspaceId,
        reason: input.reason,
        actor: input.actor,
        role: "operator",
      });
      reference = killSwitch.switchId;
      detail = { switchId: killSwitch.switchId, scope };
      break;
    }
    case "rollback": {
      const rollback = await rollbackToLastKnownGood(store, input);
      reference = rollback.reference;
      detail = rollback.detail;
      break;
    }
    case "edit": {
      if (!input.profile) {
        throw new ObserverActionError(
          "edit requires a profile payload",
          "invalid",
          400,
        );
      }
      const profile = await saveProfile({
        ...input.profile,
        actor: input.actor,
      });
      reference = `interest-profile:v${profile.version}`;
      detail = { version: profile.version };
      break;
    }
    case "approve": {
      // Sampling review is an audit acknowledgment; the decision itself stays
      // in the approvals plane (/api/approvals), never duplicated here.
      reference = input.reference ?? `approval:${input.targetRef}`;
      detail = { approvalId: input.targetRef };
      break;
    }
  }

  const action = await recordObserverAction(store, {
    actor: input.actor,
    type: input.type,
    targetRef: input.targetRef,
    reason: input.reason,
    reference,
    workspaceId: input.workspaceId,
  });
  await appendActivity(store, {
    workspaceId: input.workspaceId,
    kind: "observer.action",
    status: "recorded",
    summary: `${input.type} ${input.targetRef}: ${input.reason}`.slice(0, 500),
    payload: {
      actionId: action.actionId,
      type: action.type,
      targetRef: action.targetRef,
      reference: action.reference,
      actor: action.actor,
    },
  }).catch(() => undefined);

  return { action, detail };
}

/**
 * Re-pin the selected LKG's artifact versions. A specific previous version is
 * addressed by `reference: "lkg:<id>"`; otherwise the most recent active pin
 * (optionally narrowed by an artifact id) is chosen.
 */
async function rollbackToLastKnownGood(
  store: Store,
  input: ParsedIntervention,
): Promise<{ reference: string; detail: Record<string, unknown> }> {
  const requested = input.reference?.startsWith("lkg:")
    ? input.reference.slice("lkg:".length)
    : null;
  const source = requested
    ? await store.lkg.get(requested)
    : selectLastKnownGood(
        await store.lkg.listActive(input.workspaceId),
        input.targetRef === "workspace-artifacts" ? undefined : input.targetRef,
      );
  if (!source) {
    throw new ObserverActionError(
      "no last-known-good pin is available to roll back to",
      "invalid",
      400,
    );
  }
  const registered = await store.lkgService.register({
    workspaceId: source.workspaceId,
    targetKey: source.targetKey,
    artifactRefs: source.artifactRefs,
    verifier: `observer:${input.actor}`,
    createdBy: input.actor,
  });
  return {
    reference: `lkg:${source.lkgId}->${registered.record.lkgId}`,
    detail: {
      targetKey: source.targetKey,
      artifactRefs: source.artifactRefs,
      previous: registered.previous.map((record) => record.lkgId),
    },
  };
}

function defaultTarget(
  type: ObserverActionType,
  workspaceId: string,
  scope: KillSwitchScope | undefined,
): string {
  switch (type) {
    case "pause":
      return `workspace:${workspaceId}`;
    case "kill":
      return scope === "global" ? "global" : workspaceId;
    case "rollback":
      return "workspace-artifacts";
    case "edit":
      return "interest-profile";
    case "approve":
      return "";
  }
}

function parseScope(value: unknown): KillSwitchScope {
  const parsed = killSwitchScopeSchema.safeParse(value ?? "workspace");
  if (!parsed.success) {
    throw new ObserverActionError("invalid kill switch scope", "invalid", 400);
  }
  return parsed.data;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
