/**
 * Maps an approvals entity row plus its approval-request payload to the JSON
 * item shape the console consumed before approvals became a table. Keeping the
 * mapping pure makes the compatibility contract testable without a store.
 */

export type ApprovalRiskClass = "low" | "medium" | "high";

export interface ApprovalEntityView {
  approvalId: string;
  runId: string;
  workflowId: string | null;
  stageId: string | null;
  stageName: string | null;
  kind: string;
  status: string;
  slaDueAt: string | null;
  expiresAt: string | null;
  version: number;
  runStatus: string | null;
}

export type ApprovalPayloadView = Record<string, unknown> | null;

export interface ApprovalApiItem {
  runId: string;
  workflowId: string;
  requestId: string;
  stageId: string;
  stageName: string;
  requestType: string;
  riskClass: ApprovalRiskClass;
  summary: string;
  options: string[];
  expiresAt: string;
  status: string;
  version: number;
  slaDueAt: string | null;
  runStatus: string | null;
}

const REQUEST_TYPES = new Set([
  "stage_before",
  "stage_after",
  "gate_failure",
  "budget_exceeded",
]);

export function toApiApprovalItem(
  entity: ApprovalEntityView,
  payload: ApprovalPayloadView,
): ApprovalApiItem {
  return {
    runId: entity.runId,
    workflowId: entity.workflowId ?? "",
    requestId: entity.approvalId,
    stageId: entity.stageId ?? stringField(payload, "stageId"),
    stageName: entity.stageName ?? stringField(payload, "stageName"),
    requestType: REQUEST_TYPES.has(entity.kind)
      ? entity.kind
      : (normalizeRequestType(payload?.requestType) ?? "gate_failure"),
    riskClass: normalizeRiskClass(payload?.riskClass),
    summary: stringField(payload, "summary"),
    options: normalizeOptions(payload?.options),
    expiresAt: entity.expiresAt ?? stringField(payload, "expiresAt"),
    status: entity.status,
    version: entity.version,
    slaDueAt: entity.slaDueAt,
    runStatus: entity.runStatus,
  };
}

function normalizeRiskClass(value: unknown): ApprovalRiskClass {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "medium";
}

function normalizeRequestType(value: unknown): string | null {
  return typeof value === "string" && REQUEST_TYPES.has(value) ? value : null;
}

function normalizeOptions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((option): option is string => typeof option === "string")
    : ["approve", "abort"];
}

function stringField(payload: ApprovalPayloadView, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}
