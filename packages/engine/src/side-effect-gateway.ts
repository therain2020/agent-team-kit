import {
  type RunMode,
  type RunModeEffectApproval,
  RunModeGuardError,
  type RunModePolicy,
  assertRunModeSideEffectAllowed,
  runModePolicy,
} from "@kit/core";
import { type OpLogStore, appendOp } from "@kit/store";
import { assertWriteLeaseActive, currentWriteLease } from "./write-lease";

/**
 * Effect gateway (20 §2.4): every real side effect passes through here before
 * it leaves the process. LIVE runs execute; every other mode refuses the real
 * action, records an audit entry, and returns a stub result. The refusal is
 * deliberate and auditable rather than an exception, so a REPLAY / FORK /
 * BACKFILL / DRY_RUN run can never perform its first real side effect.
 */
export interface SideEffectContext {
  workspaceId: string;
  runId: string;
  stageId?: string;
  runMode: RunMode;
  /** e.g. `delivery.webhook`, `repo.apply`, `notification.email`. */
  action: string;
  /** Effect key from 20 §3.3 when the action carries one. */
  effectKey?: string;
  /** Explicit approval that may permit one non-LIVE real side effect. */
  approval?: RunModeEffectApproval;
  /** Target the side effect would touch (redacted by the caller if needed). */
  target?: string;
}

export interface SideEffectHandlers<T> {
  /** The real action. Only called when the policy allows it. */
  execute: () => Promise<T>;
  /**
   * Deterministic stand-in used for non-LIVE runs. Must not touch external
   * systems; typically returns `{ ok: true, skipped: true, ... }`.
   */
  stub: () => T | Promise<T>;
}

export interface SideEffectOutcome<T> {
  executed: boolean;
  policy: RunModePolicy;
  value: T;
}

export interface SideEffectGateway {
  run<T>(
    context: SideEffectContext,
    handlers: SideEffectHandlers<T>,
  ): Promise<SideEffectOutcome<T>>;
}

export class SideEffectRefusedError extends RunModeGuardError {
  constructor(context: SideEffectContext) {
    super(
      "side_effect_refused",
      `${context.runMode} runs cannot execute real side effect "${context.action}" without an approved effect key`,
      context.runMode,
    );
    this.name = "SideEffectRefusedError";
  }
}

export interface SideEffectGatewayDeps {
  store: OpLogStore;
  /** Audit writer override for tests; defaults to the op log. */
  appendAudit?: (entry: {
    workspaceId: string;
    runId: string;
    action: string;
    runMode: RunMode;
    effectKey?: string;
    target?: string;
    reason: string;
  }) => Promise<void>;
}

async function defaultAudit(
  deps: SideEffectGatewayDeps,
  context: SideEffectContext,
  reason: string,
): Promise<void> {
  const lease = currentWriteLease();
  try {
    await appendOp(deps.store, {
      workspaceId: context.workspaceId,
      entityKind: "run",
      entityId: context.runId,
      op: "side_effect.blocked",
      actor: lease?.owner ?? "engine",
      origin: "system",
      payload: {
        runId: context.runId,
        stageId: context.stageId ?? null,
        runMode: context.runMode,
        action: context.action,
        effectKey: context.effectKey ?? null,
        target: context.target ?? null,
        reason,
        lease: lease
          ? { owner: lease.owner, leaseVersion: lease.leaseVersion }
          : null,
      },
    });
  } catch (error) {
    // Audit must never turn a refusal into a run failure; the refusal itself
    // still holds because the real action is not executed.
    console.error(
      `[side-effect-gateway] audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function createSideEffectGateway(
  deps: SideEffectGatewayDeps,
): SideEffectGateway {
  return {
    async run<T>(
      context: SideEffectContext,
      handlers: SideEffectHandlers<T>,
    ): Promise<SideEffectOutcome<T>> {
      const policy = runModePolicy(context.runMode);
      let allowed = policy.sideEffects === "execute";
      if (!allowed) {
        try {
          assertRunModeSideEffectAllowed(context);
          allowed = true;
        } catch {
          allowed = false;
        }
      }

      if (allowed) {
        assertWriteLeaseActive();
        const value = await handlers.execute();
        return { executed: true, policy, value };
      }

      const reason = `${context.runMode} run: real side effect "${context.action}" refused (credentialScope=${policy.credentialScope}, sideEffects=${policy.sideEffects})`;
      if (deps.appendAudit) {
        await deps
          .appendAudit({
            workspaceId: context.workspaceId,
            runId: context.runId,
            action: context.action,
            runMode: context.runMode,
            ...(context.effectKey ? { effectKey: context.effectKey } : {}),
            ...(context.target ? { target: context.target } : {}),
            reason,
          })
          .catch(() => undefined);
      } else {
        await defaultAudit(deps, context, reason);
      }
      const value = await handlers.stub();
      return { executed: false, policy, value };
    },
  };
}
