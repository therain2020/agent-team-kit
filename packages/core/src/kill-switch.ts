import { z } from "zod";

export const killSwitchScopeSchema = z.enum([
  "global",
  "workspace",
  "agent-source",
  "stage",
]);

export type KillSwitchScope = z.infer<typeof killSwitchScopeSchema>;

export const killSwitchStateSchema = z.enum(["active", "released"]);

export type KillSwitchState = z.infer<typeof killSwitchStateSchema>;

export const killSwitchCheckpointSchema = z.enum([
  "run",
  "stage",
  "model",
  "tool",
  "delivery",
]);

export type KillSwitchCheckpoint = z.infer<typeof killSwitchCheckpointSchema>;

export const killSwitchActorRoleSchema = z.enum([
  "operator",
  "security",
  "agent",
  "system",
]);

export type KillSwitchActorRole = z.infer<typeof killSwitchActorRoleSchema>;

export const killSwitchSchema = z
  .object({
    switchId: z.string().min(1),
    scope: killSwitchScopeSchema,
    target: z.string(),
    workspaceId: z.string().min(1).nullable(),
    state: killSwitchStateSchema,
    activatedBy: z.string().min(1),
    reason: z.string().min(1),
    activatedAt: z.string().datetime(),
    releasedBy: z.string().min(1).nullable(),
    releasedAt: z.string().datetime().nullable(),
    releaseReason: z.string().min(1).nullable(),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "global") {
      if (value.target !== "" || value.workspaceId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "global kill switch must not target a workspace or agent",
          path: ["target"],
        });
      }
    }
    if (value.scope === "workspace") {
      if (!value.workspaceId || value.target !== value.workspaceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspace kill switch target must be its workspace id",
          path: ["target"],
        });
      }
    }
    if (
      (value.scope === "agent-source" || value.scope === "stage") &&
      value.target.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.scope} kill switch requires a target`,
        path: ["target"],
      });
    }
    if (value.state === "released") {
      if (!value.releasedBy || !value.releasedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "released kill switch requires releasedBy and releasedAt",
          path: ["releasedAt"],
        });
      }
    } else if (value.releasedBy || value.releasedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "active kill switch must not carry release fields",
        path: ["releasedBy"],
      });
    }
  });

export type KillSwitch = z.infer<typeof killSwitchSchema>;

export const killSwitchContextSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
  stageName: z.string().min(1).optional(),
});

export type KillSwitchContext = z.infer<typeof killSwitchContextSchema>;

const SCOPE_PRIORITY: Record<KillSwitchScope, number> = {
  global: 0,
  workspace: 1,
  "agent-source": 2,
  stage: 3,
};

export function killSwitchPriority(scope: KillSwitchScope): number {
  return SCOPE_PRIORITY[scope];
}

export interface KillSwitchIdentity {
  target: string;
  workspaceId: string | null;
}

export function normalizeKillSwitchIdentity(input: {
  scope: KillSwitchScope;
  target?: string | null;
  workspaceId?: string | null;
}): KillSwitchIdentity {
  const workspaceId = input.workspaceId?.trim() || null;
  const target = input.target?.trim() || "";
  switch (input.scope) {
    case "global":
      return { target: "", workspaceId: null };
    case "workspace":
      if (!workspaceId) {
        throw new Error("workspace kill switch requires a workspace id");
      }
      return { target: workspaceId, workspaceId };
    case "agent-source":
    case "stage":
      if (!target) {
        throw new Error(`${input.scope} kill switch requires a target`);
      }
      return { target, workspaceId };
  }
}

export function assertKillSwitchPermission(
  scope: KillSwitchScope,
  role: KillSwitchActorRole,
): void {
  if (scope === "global" && role !== "operator") {
    throw new KillSwitchPermissionError(
      "only the operator may toggle the global kill switch",
    );
  }
  if (scope === "workspace" && role !== "operator" && role !== "security") {
    throw new KillSwitchPermissionError(
      "workspace kill switches require the operator or a security alert",
    );
  }
}

export function killSwitchMatches(
  killSwitch: KillSwitch,
  context: KillSwitchContext,
): boolean {
  if (killSwitch.state !== "active") {
    return false;
  }
  if (killSwitch.scope === "global") {
    return true;
  }
  if (killSwitch.scope === "workspace") {
    return killSwitch.workspaceId === context.workspaceId;
  }
  if (
    killSwitch.workspaceId !== null &&
    killSwitch.workspaceId !== context.workspaceId
  ) {
    return false;
  }
  if (killSwitch.scope === "agent-source") {
    return Boolean(context.agentId && killSwitch.target === context.agentId);
  }
  return (
    killSwitch.target === context.stageId ||
    killSwitch.target === context.stageName
  );
}

export function resolveKillSwitch(
  killSwitches: readonly KillSwitch[],
  context: KillSwitchContext,
): KillSwitch | null {
  const matches = killSwitches
    .filter((killSwitch) => killSwitchMatches(killSwitch, context))
    .sort((left, right) => {
      const priority =
        killSwitchPriority(left.scope) - killSwitchPriority(right.scope);
      if (priority !== 0) {
        return priority;
      }
      return left.activatedAt.localeCompare(right.activatedAt);
    });
  return matches[0] ?? null;
}

export class KillSwitchTrippedError extends Error {
  constructor(
    readonly killSwitch: KillSwitch,
    readonly checkpoint: KillSwitchCheckpoint,
  ) {
    super(
      `kill switch tripped at ${checkpoint}: ${killSwitch.scope}/${
        killSwitch.target || "*"
      } — ${killSwitch.reason}`,
    );
    this.name = "KillSwitchTrippedError";
  }
}

export function isKillSwitchTrippedError(
  error: unknown,
): error is KillSwitchTrippedError {
  return error instanceof KillSwitchTrippedError;
}

export class KillSwitchPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchPermissionError";
  }
}
