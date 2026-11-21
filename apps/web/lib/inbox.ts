import { microToCny } from "@kit/core";
import type { ArtifactVersion } from "@kit/core";
import { cache } from "react";
import { ensureApprovalsBackfill } from "./approvals";
import type {
  ApprovalGateScore,
  ApprovalRiskClass,
  ApprovalTowerCard,
  ApprovalTowerSnapshot,
} from "./inbox-shared";
import { loadArtifactContent, loadRunDetail, loadRunSummaries } from "./runs";
import { ensureStoreSchema, getStore } from "./store";

type Store = Awaited<ReturnType<typeof getStore>>;

/** Page size of the approval tower; the SLA inbox is meant to be exhaustive. */
export const TOWER_LIMIT = 200;

/** Operators without a session identity all share the local console actor. */
const DEFAULT_WORKSPACE = "default";
const SNIPPET_CHARS = 280;
const PAYLOAD_CHARS = 200_000;
const GATE_CHARS = 40_000;

export type {
  ApprovalBudgetImpact,
  ApprovalGateScore,
  ApprovalRiskClass,
  ApprovalTowerCard,
  ApprovalTowerSnapshot,
  TowerBucket,
  TowerBucketId,
} from "./inbox-shared";
export { groupApprovals, medianWait } from "./inbox-shared";

/**
 * Server read path for the approval tower: one indexed approvals SELECT, then
 * bounded enrichment (payload, draft preview, gate score, run budget).
 */
export const loadApprovalTower = cache(async function loadApprovalTower(
  store?: Store,
): Promise<ApprovalTowerSnapshot> {
  await ensureStoreSchema();
  await ensureApprovalsBackfill();
  const client = store ?? (await getStore());

  const [page, budgets] = await Promise.all([
    client.approvals.list({
      status: "queued",
      runStatus: "paused",
      sort: "due",
      limit: TOWER_LIMIT,
    }),
    client.budgetService
      .listBudgets({
        workspaceId: DEFAULT_WORKSPACE,
        scope: "run",
        limit: 2000,
      })
      .catch(() => []),
  ]);

  const budgetByRun = new Map(
    budgets.map((budget) => [budget.targetKey, budget]),
  );

  const cards = await mapLimit(page.items, 12, async (item) => {
    // Change-scoped approvals have no run; their evidence is the proposal row
    // (hypothesis, risk, revertRef, eval plan), not an artifact payload.
    const proposal = item.changeId
      ? await client.changeProposals.get(item.changeId).catch(() => null)
      : null;
    const payload = proposal
      ? null
      : await readPayload(client, item.payloadRef);
    const draftArtifactId = stringValue(payload?.draftArtifactId);
    const draftVersion = numberValue(payload?.draftVersion) ?? 1;
    const gateRefs = gateRefsFrom(payload);
    const [draftSnippet, gate] = await Promise.all([
      draftArtifactId
        ? readSnippet(client, draftArtifactId, draftVersion)
        : Promise.resolve(""),
      gateRefs[0] ? readGateScore(client, gateRefs[0]) : Promise.resolve(null),
    ]);
    const budget = budgetByRun.get(item.runId);
    const dueAt = item.slaDueAt ?? item.expiresAt ?? item.createdAt;

    return {
      requestId: item.approvalId,
      runId: item.runId,
      changeId: item.changeId,
      substrate: proposal?.substrate ?? item.substrate ?? null,
      revertRef: proposal?.revertRef ?? null,
      workflowId: item.workflowId ?? "",
      stageId: item.stageId ?? "",
      stageName: item.stageName ?? "",
      kind: item.kind,
      requestType: item.changeId
        ? "change_proposal"
        : requestTypeFrom(item.kind, payload),
      riskClass: proposal
        ? riskClassFrom({ riskClass: proposal.risk })
        : riskClassFrom(payload),
      summary: proposal?.hypothesis ?? stringValue(payload?.summary) ?? "",
      requester:
        stringValue(payload?.requestedBy) ?? item.requester ?? "manager",
      assignee: item.assignee ?? null,
      status: item.status,
      version: item.version,
      createdAt: item.createdAt,
      dueAt,
      expiresAt: item.expiresAt,
      draftArtifactId,
      draftSnippet,
      gate,
      budget: budget
        ? {
            spentCny: microToCny(budget.spentCnyMicro),
            limitCny:
              budget.limitCnyMicro === null
                ? null
                : microToCny(budget.limitCnyMicro),
          }
        : null,
      runStatus: item.runStatus,
    } satisfies ApprovalTowerCard;
  });

  return {
    approvals: cards,
    generatedAt: new Date().toISOString(),
    truncated: page.nextCursor !== null,
  };
});

export interface ApprovalEvidenceRef {
  artifactId: string;
  version: number;
  stageId: string;
  relation: string;
}

export interface ApprovalWhy {
  draftArtifactId: string | null;
  producedBy: ApprovalEvidenceRef[];
  consumedBy: ApprovalEvidenceRef[];
  gates: ApprovalGateScore[];
}

/**
 * "Why" card: a short evidence excerpt from `artifact_edges` around the draft
 * under review — what produced it, who consumed it, and which gate judged it.
 */
export const loadApprovalWhy = cache(async function loadApprovalWhy(
  requestId: string,
  store?: Store,
): Promise<ApprovalWhy | null> {
  await ensureStoreSchema();
  const client = store ?? (await getStore());
  const record = await client.approvals.get(requestId);
  if (!record) {
    return null;
  }
  const payload = await readPayload(client, record.payloadRef);
  const draftArtifactId = stringValue(payload?.draftArtifactId);
  const draftVersion = numberValue(payload?.draftVersion) ?? 1;
  const gateRefs = gateRefsFrom(payload);

  const [ancestry, consumers, gates] = await Promise.all([
    draftArtifactId
      ? client.artifactStore
          .ancestryOf(draftArtifactId, draftVersion, { maxDepth: 2 })
          .catch(() => [])
      : Promise.resolve([]),
    draftArtifactId
      ? client.artifactStore
          .consumersOf(draftArtifactId, draftVersion)
          .catch(() => [])
      : Promise.resolve([]),
    mapLimit(gateRefs.slice(0, 4), 4, (ref) => readGateScore(client, ref)),
  ]);

  const [producedBy, consumedBy] = await Promise.all([
    mapLimit(ancestry, 6, async (node) => ({
      artifactId: node.artifactId,
      version: node.version,
      stageId: await stageOf(client, node.artifactId, node.version),
      relation: node.relation,
    })),
    mapLimit(consumers, 6, async (ref) => ({
      artifactId: ref.artifactId,
      version: ref.version,
      stageId: await stageOf(client, ref.artifactId, ref.version),
      relation: "consumed",
    })),
  ]);

  return {
    draftArtifactId,
    producedBy,
    consumedBy,
    gates: gates.filter((gate): gate is ApprovalGateScore => gate !== null),
  };
});

async function readPayload(
  client: Store,
  payloadRef: string | null,
): Promise<Record<string, unknown> | null> {
  if (!payloadRef) {
    return null;
  }
  const artifact = await client.artifactStore.findById(payloadRef);
  if (!artifact) {
    return null;
  }
  return readJson(client, artifact, PAYLOAD_CHARS);
}

async function readSnippet(
  client: Store,
  artifactId: string,
  version: number,
): Promise<string> {
  const artifact = await client.artifactStore.findById(artifactId, version);
  if (!artifact) {
    return "";
  }
  const content = await loadArtifactContent(
    artifact,
    client,
    SNIPPET_CHARS * 4,
  );
  if (content.unavailable || !content.text) {
    return "";
  }
  const collapsed = content.text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_CHARS
    ? `${collapsed.slice(0, SNIPPET_CHARS)}…`
    : collapsed;
}

async function readGateScore(
  client: Store,
  ref: { artifactId: string; version: number },
): Promise<ApprovalGateScore | null> {
  const artifact = await client.artifactStore.findById(
    ref.artifactId,
    ref.version,
  );
  if (!artifact) {
    return null;
  }
  const parsed = await readJson(client, artifact, GATE_CHARS);
  if (!parsed) {
    return null;
  }
  const scores = numberRecord(parsed.scores);
  const thresholds = numberRecord(parsed.thresholds);
  const dimensions = new Set([
    ...Object.keys(scores),
    ...Object.keys(thresholds),
  ]);
  return {
    artifactId: ref.artifactId,
    pass: typeof parsed.pass === "boolean" ? parsed.pass : null,
    scores: [...dimensions].map((dimension) => ({
      dimension,
      value: scores[dimension] ?? 0,
      threshold: thresholds[dimension] ?? null,
    })),
    rationale: stringValue(parsed.rationale) ?? "",
  };
}

async function stageOf(
  client: Store,
  artifactId: string,
  version: number,
): Promise<string> {
  const artifact = await client.artifactStore.findById(artifactId, version);
  if (!artifact) {
    return "";
  }
  const manifest = await client.manifests.get(artifact.manifestId);
  return manifest?.stageId ?? "";
}

async function readJson(
  client: Store,
  artifact: ArtifactVersion,
  maxChars: number,
): Promise<Record<string, unknown> | null> {
  const content = await loadArtifactContent(artifact, client, maxChars);
  if (content.unavailable) {
    return null;
  }
  try {
    const parsed = JSON.parse(content.text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requestTypeFrom(
  kind: string,
  payload: Record<string, unknown> | null,
): string {
  if (
    kind === "stage_before" ||
    kind === "stage_after" ||
    kind === "gate_failure" ||
    kind === "budget_exceeded"
  ) {
    return kind;
  }
  return stringValue(payload?.requestType) ?? "gate_failure";
}

function riskClassFrom(
  payload: Record<string, unknown> | null,
): ApprovalRiskClass {
  const value = payload?.riskClass;
  return value === "low" || value === "high" ? value : "medium";
}

function gateRefsFrom(
  payload: Record<string, unknown> | null,
): Array<{ artifactId: string; version: number }> {
  const raw = payload?.gateRefs;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((ref) => {
    if (
      typeof ref === "object" &&
      ref !== null &&
      typeof (ref as { artifactId?: unknown }).artifactId === "string"
    ) {
      const value = ref as { artifactId: string; version?: unknown };
      return [
        {
          artifactId: value.artifactId,
          version: typeof value.version === "number" ? value.version : 1,
        },
      ];
    }
    return [];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      record[key] = entry;
    }
  }
  return record;
}

/** Bounded-concurrency map so enrichment cannot exhaust blobs or sockets. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await fn(item);
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
