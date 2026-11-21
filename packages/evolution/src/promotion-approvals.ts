import path from "node:path";
import { newId } from "@kit/core";
import type { ApprovalRecord, ApprovalService } from "@kit/store";
import {
  type PromotionApproval,
  type VariantKind,
  isPromotionRole,
  promotionRiskClass,
  requiredPromotionRoles,
} from "./promotion";

/**
 * Promotion approvals ride on the unified approval inbox (`approvals` table)
 * instead of a parallel system: one queued row per required role, keyed by
 * `subject_ref` so the inbox can list them without a run (70 §3.1, #88).
 */

export function promotionSubjectRef(
  variantId: string,
  targetDir: string,
): string {
  const target = path.resolve(targetDir).split(path.sep).join("/");
  return `promotion:${variantId}:${target}`;
}

export interface RequestPromotionApprovalsInput {
  workspaceId: string;
  variantId: string;
  variantKind: VariantKind;
  targetDir: string;
  requester?: string;
  now?: string;
}

/** Queues one approval per required role for the promotion subject. */
export async function requestPromotionApprovals(
  approvals: ApprovalService,
  input: RequestPromotionApprovalsInput,
): Promise<ApprovalRecord[]> {
  const roles = requiredPromotionRoles(input.variantKind);
  const subjectRef = promotionSubjectRef(input.variantId, input.targetDir);
  const createdAt = input.now ?? new Date().toISOString();
  const riskClass = promotionRiskClass(input.variantKind);
  const records: ApprovalRecord[] = [];
  for (const role of roles) {
    records.push(
      await approvals.enqueue({
        approvalId: newId("apr"),
        workspaceId: input.workspaceId,
        runId: input.variantId,
        kind: "promotion",
        requester: input.requester ?? "operator",
        requiredRole: role,
        subjectRef,
        payloadRef: subjectRef,
        riskClass,
        createdAt,
      }),
    );
  }
  return records;
}

/** Reads the approval rows recorded for one promotion subject. */
export async function loadPromotionApprovals(
  approvals: ApprovalService,
  input: { workspaceId: string; variantId: string; targetDir: string },
): Promise<PromotionApproval[]> {
  const page = await approvals.list({
    workspaceId: input.workspaceId,
    kind: "promotion",
    subjectRef: promotionSubjectRef(input.variantId, input.targetDir),
    sort: "created",
    limit: 50,
  });
  return page.items.flatMap((item) => {
    const role = item.requiredRole;
    if (!isPromotionRole(role)) {
      return [];
    }
    return [
      {
        approvalId: item.approvalId,
        role,
        status: item.status,
        workspaceId: item.workspaceId,
        decidedBy: item.decisionBy,
        decidedAt: item.decisionAt,
      },
    ];
  });
}
