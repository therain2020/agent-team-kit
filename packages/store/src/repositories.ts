import type {
  ArtifactVersion,
  Blob,
  DegradationAuditAction,
  DegradationScope,
  DegradationTrigger,
  DegradedModeKind,
  DegradedModeStatus,
  EventEnvelope,
  ExitCriteria,
  Incident,
  KillSwitch,
  LastKnownGood,
  Manifest,
  QualityFloor,
  RecoveryDrill,
  Run,
  Runbook,
  RunbookDrill,
  RunMode,
  RunOriginKind,
  RunStatus,
  Sensitivity,
  Stage,
  StageStatus,
} from "@kit/core";
import { newId, switchLastKnownGood } from "@kit/core";
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./db";
import type { OpLogStore } from "./op-log";
import {
  events,
  artifactEdges,
  artifacts,
  autopilotState,
  blobs,
  degradationAudit,
  degradationState,
  incidents,
  killSwitches,
  lastKnownGood,
  managerSessions,
  manifests,
  recoveryDrills,
  runRequests,
  runbookDrills,
  runbooks,
  runs,
  stages,
} from "./schema";
import {
  VersionConflictError,
  type WriteConflictDetail,
  type WriteLease,
  type WriteOptions,
  conflictDetail,
  leaseClaimExists,
  recordWriteConflict,
} from "./write-fencing";

export interface EventStore {
  insert(event: EventEnvelope): Promise<{ inserted: boolean }>;
  findByIdempotencyKey(key: string): Promise<EventEnvelope | null>;
}

export interface RunStore {
  create(run: Run): Promise<void>;
  /**
   * Updates a run. `version` is bumped on every write. When `options.lease`
   * or `options.expectedVersion` is supplied the update is conditional and a
   * stale caller gets a `VersionConflictError` instead of a silent overwrite.
   */
  updateStatus(
    runId: string,
    status: Run["status"],
    updatedAt: string,
    options?: WriteOptions,
  ): Promise<void>;
  get(runId: string): Promise<Run | null>;
  /** Current optimistic-lock version, or null when the run does not exist. */
  getVersion(runId: string): Promise<number | null>;
  listRecent(limit?: number): Promise<Run[]>;
  list(options?: {
    status?: RunStatus;
    limit?: number;
    offset?: number;
  }): Promise<Run[]>;
}

export interface StageStore {
  create(stage: Stage): Promise<void>;
  /**
   * Read-modify-write update. `version` is bumped on every write; pass
   * `options.expectedVersion` (from `getVersion`) for a CAS update.
   */
  update(stage: Stage, options?: WriteOptions): Promise<void>;
  updateStatus(
    stageId: string,
    status: Stage["status"],
    timestamps?: { startedAt?: string; finishedAt?: string },
    options?: WriteOptions,
  ): Promise<void>;
  /** Current optimistic-lock version, or null when the stage does not exist. */
  getVersion(stageId: string): Promise<number | null>;
  listByRun(runId: string): Promise<Stage[]>;
}

export interface ManifestStore {
  put(manifest: Manifest): Promise<void>;
  get(manifestId: string): Promise<Manifest | null>;
}

export interface BlobRepository {
  findById(blobId: string): Promise<Blob | null>;
  find(workspaceId: string, sha256: string): Promise<Blob | null>;
  insert(blob: Blob): Promise<boolean>;
}

export type ArtifactEdgeRelation = "consumed" | "superseded" | "derived";

export interface ArtifactVersionRef {
  artifactId: string;
  version: number;
}

export interface ArtifactAncestryNode extends ArtifactVersionRef {
  depth: number;
  relation: ArtifactEdgeRelation;
}

export interface ArtifactEdgeLink {
  from: ArtifactVersionRef;
  to: ArtifactVersionRef;
  relation: ArtifactEdgeRelation;
}

export interface ArtifactEdgeBackfillResult {
  inserted: number;
  skipped: number;
}

export interface ArtifactStore {
  createCommitted(manifest: Manifest, artifact: ArtifactVersion): Promise<void>;
  putVersion(artifact: ArtifactVersion): Promise<void>;
  commit(artifactId: string, version: number): Promise<void>;
  findById(
    artifactId: string,
    version?: number,
  ): Promise<ArtifactVersion | null>;
  findCommittedByRunStage(
    runId: string,
    stageId: string,
  ): Promise<ArtifactVersion | null>;
  listByRun(runId: string): Promise<ArtifactVersion[]>;
  listRecent(workspaceId: string, limit?: number): Promise<ArtifactVersion[]>;
  /** ArtifactVersions whose manifest consumed the given version. */
  consumersOf(
    artifactId: string,
    version: number,
  ): Promise<ArtifactVersionRef[]>;
  /** Transitive inputs (consumed + superseded) of the given version. */
  ancestryOf(
    artifactId: string,
    version: number,
    options?: { maxDepth?: number },
  ): Promise<ArtifactAncestryNode[]>;
  /** Re-materializes edges from manifests.input_refs + artifacts.supersedes. */
  backfillEdges(): Promise<ArtifactEdgeBackfillResult>;
}

export interface LastKnownGoodSwitch {
  record: LastKnownGood;
  previous: LastKnownGood[];
  changed: boolean;
}

/**
 * The active LKG pin per workspace target. The table keeps every registered
 * pin so a switch can be audited and reversed.
 */
export interface LastKnownGoodStore {
  get(lkgId: string): Promise<LastKnownGood | null>;
  listActive(workspaceId?: string): Promise<LastKnownGood[]>;
  history(
    workspaceId: string,
    targetKey: string,
    limit?: number,
  ): Promise<LastKnownGood[]>;
  /** Supersedes the active pins of the record's workspace target. */
  switch(record: LastKnownGood): Promise<LastKnownGoodSwitch>;
}

export interface AutopilotStateRecord {
  workspaceId: string;
  packDir: string;
  enabled: boolean;
  lastTickAt: string | null;
  nextRuns: Record<string, string>;
  day: string | null;
  runsToday: number;
  spentToday: number;
  lastError: string | null;
  updatedAt: string;
  version: number;
}

/** Discriminates which pipeline a queued local request belongs to. */
export type RunRequestKind = "pack_run" | "iteration";

export interface RunRequestRecord {
  requestId: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  kind: RunRequestKind;
  payload: string;
  status: "queued" | "claimed" | "done" | "failed" | "cancelled";
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  /** Fencing token; incremented on every claim. */
  leaseVersion: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KillSwitchActivation {
  record: KillSwitch;
  changed: boolean;
}

export interface KillSwitchStore {
  activate(record: KillSwitch): Promise<KillSwitchActivation>;
  release(
    switchId: string,
    releasedBy: string,
    releaseReason: string,
    releasedAt: string,
  ): Promise<KillSwitchActivation | null>;
  get(switchId: string): Promise<KillSwitch | null>;
  listActive(): Promise<KillSwitch[]>;
  list(limit?: number): Promise<KillSwitch[]>;
}

export interface RunRequestStore {
  enqueue(
    record: Pick<
      RunRequestRecord,
      | "requestId"
      | "runId"
      | "workspaceId"
      | "workflowId"
      | "kind"
      | "payload"
      | "createdAt"
      | "updatedAt"
    >,
  ): Promise<void>;
  claimNext(
    owner: string,
    now: Date,
    staleMs: number,
  ): Promise<RunRequestRecord | null>;
  /**
   * Renews a claim. With `expectedLeaseVersion` the renewal is fenced: the
   * heartbeat affects 0 rows and raises a `VersionConflictError` when the
   * request was re-claimed by another worker. Returns null when no expected
   * version was supplied and the row is no longer held by `owner`.
   */
  heartbeat(
    requestId: string,
    owner: string,
    now: Date,
    expectedLeaseVersion?: number,
  ): Promise<RunRequestRecord | null>;
  /**
   * Marks a request terminal. Supplying `lease` fences the write so a worker
   * whose lease was superseded cannot overwrite the new owner's state.
   */
  finish(
    requestId: string,
    status: "done" | "failed" | "cancelled",
    error?: string,
    lease?: Pick<WriteLease, "owner" | "leaseVersion">,
  ): Promise<void>;
  find(runId: string): Promise<RunRequestRecord | null>;
}

export interface AutopilotStateStore {
  get(
    workspaceId: string,
    packDir: string,
  ): Promise<AutopilotStateRecord | null>;
  list(workspaceId: string): Promise<AutopilotStateRecord[]>;
  insertIfMissing(record: AutopilotStateRecord): Promise<void>;
  /** Optimistic update; returns false and leaves the record untouched on a version conflict. */
  update(record: AutopilotStateRecord): Promise<boolean>;
}

export interface ManagerSessionRecord {
  workspaceId: string;
  sessionId: string;
  windowStartedAt: string;
  windowEndsAt: string;
  firstAt: string;
  lastAt: string;
  tokens: number;
  costCny: number;
  exchanges: number;
  rejections: number;
  lastRejectionReason: string | null;
  updatedAt: string;
}

export interface ManagerSessionUsageInput {
  workspaceId: string;
  sessionId: string;
  tokens: number;
  costCny: number;
  now: string;
  windowMs: number;
}

export interface ManagerSessionRejectionInput {
  workspaceId: string;
  sessionId: string;
  reason: string;
  now: string;
  windowMs: number;
}

export interface ManagerSessionStore {
  get(
    workspaceId: string,
    sessionId: string,
  ): Promise<ManagerSessionRecord | null>;
  /** Adds one exchange's usage, rolling to a fresh window when the old one expired. */
  addUsage(input: ManagerSessionUsageInput): Promise<ManagerSessionRecord>;
  /** Records a rejected request without adding tokens or cost. */
  recordRejection(
    input: ManagerSessionRejectionInput,
  ): Promise<ManagerSessionRecord>;
  reset(workspaceId: string, sessionId: string): Promise<void>;
}

export function toEventRow(event: EventEnvelope) {
  return {
    eventId: event.eventId,
    type: event.type,
    workspaceId: event.workspaceId,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    traceId: event.traceId,
    payloadRef: event.payloadRef,
  };
}

export function fromEventRow(row: typeof events.$inferSelect): EventEnvelope {
  return {
    eventId: row.eventId,
    type: row.type,
    schemaVersion: "1.0",
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    traceId: row.traceId,
    payloadRef: row.payloadRef,
  };
}

export function toRunRow(run: Run) {
  return {
    runId: run.runId,
    eventId: run.eventId,
    workspaceId: run.workspaceId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    runMode: run.runMode,
    status: run.status,
    originKind: run.originKind ?? null,
    triggerId: run.triggerId ?? null,
    triggerRunId: run.triggerRunId ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function fromRunRow(row: typeof runs.$inferSelect): Run {
  return {
    runId: row.runId,
    eventId: row.eventId,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    runMode: row.runMode as RunMode,
    status: row.status as RunStatus,
    // Pre-upgrade rows have no origin; surface them as `unknown` instead of
    // pretending they were operator-initiated.
    originKind: (row.originKind as RunOriginKind | null) ?? "unknown",
    ...(row.triggerId ? { triggerId: row.triggerId } : {}),
    ...(row.triggerRunId ? { triggerRunId: row.triggerRunId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toStageRow(stage: Stage) {
  return {
    stageId: stage.stageId,
    runId: stage.runId,
    name: stage.name,
    status: stage.status,
    startedAt: stage.startedAt ?? null,
    finishedAt: stage.finishedAt ?? null,
    checkpointId: stage.checkpointId ?? null,
    error: stage.error ?? null,
  };
}

export function fromStageRow(row: typeof stages.$inferSelect): Stage {
  return {
    stageId: row.stageId,
    runId: row.runId,
    name: row.name,
    status: row.status as StageStatus,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    checkpointId: row.checkpointId ?? undefined,
    error: row.error ?? undefined,
  };
}

export function toManifestRow(manifest: Manifest) {
  return {
    manifestId: manifest.manifestId,
    workspaceId: manifest.workspaceId,
    producer: manifest.producer,
    inputRefs: manifest.inputs,
    runId: manifest.runId,
    stageId: manifest.stageId,
    runMode: manifest.runMode,
    cost: manifest.cost,
    evalRefs: manifest.evalRefs,
    approvalRefs: manifest.approvalRefs,
    sensitivity: manifest.sensitivity,
    retentionClass: manifest.retentionClass,
    createdAt: manifest.createdAt,
  };
}

export function fromManifestRow(row: typeof manifests.$inferSelect): Manifest {
  return {
    manifestId: row.manifestId,
    workspaceId: row.workspaceId,
    producer: row.producer,
    inputs: row.inputRefs,
    runId: row.runId,
    stageId: row.stageId,
    runMode: row.runMode as RunMode,
    cost: row.cost,
    evalRefs: row.evalRefs,
    approvalRefs: row.approvalRefs,
    sensitivity: row.sensitivity as Sensitivity,
    retentionClass: row.retentionClass,
    createdAt: row.createdAt,
  };
}

export function toBlobRow(blob: Blob) {
  return {
    blobId: blob.blobId,
    workspaceId: blob.workspaceId,
    sha256: blob.sha256,
    size: blob.size,
    storageKey: blob.storageKey,
    createdAt: blob.createdAt,
  };
}

export function fromBlobRow(row: typeof blobs.$inferSelect): Blob {
  return {
    blobId: row.blobId,
    workspaceId: row.workspaceId,
    sha256: row.sha256,
    size: Number(row.size),
    storageKey: row.storageKey,
    createdAt: row.createdAt,
  };
}

export function toArtifactRow(artifact: ArtifactVersion) {
  return {
    artifactId: artifact.artifactId,
    version: artifact.version,
    workspaceId: artifact.workspaceId,
    blobId: artifact.blobId,
    manifestId: artifact.manifestId,
    status: artifact.status,
    supersedes: artifact.supersedes,
    supersededBy: artifact.supersededBy,
    createdAt: artifact.createdAt,
  };
}

export function fromArtifactRow(
  row: typeof artifacts.$inferSelect,
): ArtifactVersion {
  return {
    artifactId: row.artifactId,
    version: row.version,
    workspaceId: row.workspaceId,
    blobId: row.blobId,
    manifestId: row.manifestId,
    status: row.status as ArtifactVersion["status"],
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
  };
}

export function toLastKnownGoodRow(record: LastKnownGood) {
  return {
    lkgId: record.lkgId,
    workspaceId: record.workspaceId,
    targetKey: record.targetKey,
    artifactRefs: record.artifactRefs,
    verifiedAt: record.verifiedAt,
    verifier: record.verifier,
    status: record.status,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  };
}

export function fromLastKnownGoodRow(
  row: typeof lastKnownGood.$inferSelect,
): LastKnownGood {
  return {
    lkgId: row.lkgId,
    workspaceId: row.workspaceId,
    targetKey: row.targetKey,
    artifactRefs: row.artifactRefs,
    verifiedAt: row.verifiedAt,
    verifier: row.verifier,
    status: row.status as LastKnownGood["status"],
    supersedes: row.supersedes ?? null,
    supersededBy: row.supersededBy ?? null,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

export const ARTIFACT_KIND = "artifact";

/** Shape shared by the Postgres and SQLite `artifact_edges` tables. */
export interface ArtifactEdgeRow {
  edgeId: string;
  workspaceId: string;
  fromKind: string;
  fromId: string;
  fromVersion: number;
  toKind: string;
  toId: string;
  toVersion: number;
  relation: ArtifactEdgeRelation;
  createdAt: string;
}

export function artifactVersionKey(ref: ArtifactVersionRef): string {
  return `${ref.artifactId}@${ref.version}`;
}

/**
 * Parses an `artifacts.supersedes` value. Lineage endpoints are versioned
 * (30 §3.2), so a bare artifact id without a version cannot form an edge.
 * Accepted forms: `art_xxx@2`, `art_xxx#2`, `art_xxx:v2`, `art_xxx:2`.
 */
export function parseArtifactRef(
  ref: string | null | undefined,
): ArtifactVersionRef | null {
  if (!ref) {
    return null;
  }
  const match = /^([^@#:]+?)[@#:](?:v)?(\d+)$/.exec(ref.trim());
  if (!match) {
    return null;
  }
  const [, artifactId, rawVersion] = match;
  const version = Number(rawVersion);
  if (!artifactId || !Number.isInteger(version) || version < 1) {
    return null;
  }
  return { artifactId, version };
}

/**
 * Builds the outgoing lineage edges of one ArtifactVersion: one `consumed`
 * edge per manifest input and one `superseded` edge for `artifact.supersedes`.
 */
export function buildArtifactEdgeRows(
  artifact: ArtifactVersion,
  inputs: readonly ArtifactVersionRef[],
): { rows: ArtifactEdgeRow[]; skipped: number } {
  const rows: ArtifactEdgeRow[] = [];
  const seen = new Set<string>();
  const push = (to: ArtifactVersionRef, relation: ArtifactEdgeRelation) => {
    if (
      to.artifactId === artifact.artifactId &&
      to.version === artifact.version
    ) {
      return;
    }
    const key = `${artifactVersionKey(to)}:${relation}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    rows.push({
      edgeId: newId("aed"),
      workspaceId: artifact.workspaceId,
      fromKind: ARTIFACT_KIND,
      fromId: artifact.artifactId,
      fromVersion: artifact.version,
      toKind: ARTIFACT_KIND,
      toId: to.artifactId,
      toVersion: to.version,
      relation,
      createdAt: artifact.createdAt,
    });
  };

  for (const input of inputs) {
    push(input, "consumed");
  }

  let skipped = 0;
  if (artifact.supersedes) {
    const superseded = parseArtifactRef(artifact.supersedes);
    if (superseded) {
      push(superseded, "superseded");
    } else {
      skipped += 1;
    }
  }

  return { rows, skipped };
}

export function chunkArtifactEdgeRows(
  rows: readonly ArtifactEdgeRow[],
  size: number,
): ArtifactEdgeRow[][] {
  const chunks: ArtifactEdgeRow[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

/** Breadth-first walk over outgoing lineage edges, cycle-safe. */
export async function collectArtifactAncestry(
  start: ArtifactVersionRef,
  fetchOutgoing: (
    frontier: ArtifactVersionRef[],
  ) => Promise<ArtifactEdgeLink[]>,
  maxDepth = 64,
): Promise<ArtifactAncestryNode[]> {
  const seen = new Set([artifactVersionKey(start)]);
  const nodes: ArtifactAncestryNode[] = [];
  let frontier: ArtifactVersionRef[] = [{ ...start }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const links = await fetchOutgoing(frontier);
    const next: ArtifactVersionRef[] = [];
    for (const link of links) {
      const key = artifactVersionKey(link.to);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      nodes.push({ ...link.to, depth, relation: link.relation });
      next.push({ ...link.to });
    }
    frontier = next;
  }

  return nodes;
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly db: Database) {}

  async insert(event: EventEnvelope): Promise<{ inserted: boolean }> {
    const rows = await this.db
      .insert(events)
      .values(toEventRow(event))
      .onConflictDoNothing()
      .returning({ eventId: events.eventId });

    return { inserted: rows.length > 0 };
  }

  async findByIdempotencyKey(key: string): Promise<EventEnvelope | null> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(eq(events.idempotencyKey, key))
      .limit(1);

    return row ? fromEventRow(row) : null;
  }
}

export class PostgresRunStore implements RunStore {
  constructor(
    private readonly db: Database,
    private readonly opLog?: OpLogStore,
  ) {}

  async create(run: Run): Promise<void> {
    await this.db.insert(runs).values(toRunRow(run)).onConflictDoNothing();
  }

  async updateStatus(
    runId: string,
    status: Run["status"],
    updatedAt: string,
    options: WriteOptions = {},
  ): Promise<void> {
    const guarded =
      Boolean(options.lease) || options.expectedVersion !== undefined;
    const conditions: SQL[] = [eq(runs.runId, runId)];
    if (options.lease) {
      conditions.push(leaseClaimExists(runs.runId, options.lease));
    }
    if (options.expectedVersion !== undefined) {
      conditions.push(eq(runs.version, options.expectedVersion));
    }
    const rows = await this.db
      .update(runs)
      .set({ status, updatedAt, version: sql`${runs.version} + 1` })
      .where(and(...conditions))
      .returning({ runId: runs.runId });
    if (rows.length === 0 && guarded) {
      await this.rejectWrite(runId, options);
    }
  }

  async get(runId: string): Promise<Run | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);

    return row ? fromRunRow(row) : null;
  }

  async getVersion(runId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ version: runs.version })
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);
    return row ? Number(row.version) : null;
  }

  private async rejectWrite(
    runId: string,
    options: WriteOptions,
  ): Promise<never> {
    const currentVersion = await this.getVersion(runId).catch(() => null);
    const detail = conflictDetail("run", runId, options, currentVersion);
    let workspaceId: string | null = null;
    try {
      const [row] = await this.db
        .select({ workspaceId: runs.workspaceId })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      workspaceId = row?.workspaceId ?? null;
    } catch {
      workspaceId = null;
    }
    await recordWriteConflict(this.opLog, detail, {
      workspaceId,
      actor: options.lease?.owner ?? "engine",
    });
    throw new VersionConflictError(detail);
  }

  async listRecent(limit = 20): Promise<Run[]> {
    return this.list({ limit });
  }

  async list(
    options: { status?: RunStatus; limit?: number; offset?: number } = {},
  ): Promise<Run[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const rows = await this.db
      .select()
      .from(runs)
      .where(options.status ? eq(runs.status, options.status) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map(fromRunRow);
  }
}

export class PostgresStageStore implements StageStore {
  constructor(
    private readonly db: Database,
    private readonly opLog?: OpLogStore,
  ) {}

  async create(stage: Stage): Promise<void> {
    await this.db
      .insert(stages)
      .values(toStageRow(stage))
      .onConflictDoNothing();
  }

  async update(stage: Stage, options: WriteOptions = {}): Promise<void> {
    const guarded =
      Boolean(options.lease) || options.expectedVersion !== undefined;
    const conditions: SQL[] = [eq(stages.stageId, stage.stageId)];
    if (options.lease) {
      conditions.push(leaseClaimExists(stages.runId, options.lease));
    }
    if (options.expectedVersion !== undefined) {
      conditions.push(eq(stages.version, options.expectedVersion));
    }
    const rows = await this.db
      .update(stages)
      .set({
        ...toStageRow(stage),
        version: sql`${stages.version} + 1`,
      })
      .where(and(...conditions))
      .returning({ stageId: stages.stageId });
    if (rows.length === 0 && guarded) {
      await this.rejectWrite(stage.stageId, stage.runId, options);
    }
  }

  async updateStatus(
    stageId: string,
    status: Stage["status"],
    timestamps: { startedAt?: string; finishedAt?: string } = {},
    options: WriteOptions = {},
  ): Promise<void> {
    const guarded =
      Boolean(options.lease) || options.expectedVersion !== undefined;
    const conditions: SQL[] = [eq(stages.stageId, stageId)];
    if (options.lease) {
      conditions.push(leaseClaimExists(stages.runId, options.lease));
    }
    if (options.expectedVersion !== undefined) {
      conditions.push(eq(stages.version, options.expectedVersion));
    }
    const rows = await this.db
      .update(stages)
      .set({
        status,
        ...(timestamps.startedAt ? { startedAt: timestamps.startedAt } : {}),
        ...(timestamps.finishedAt ? { finishedAt: timestamps.finishedAt } : {}),
        version: sql`${stages.version} + 1`,
      })
      .where(and(...conditions))
      .returning({ stageId: stages.stageId });
    if (rows.length === 0 && guarded) {
      await this.rejectWrite(stageId, null, options);
    }
  }

  async getVersion(stageId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ version: stages.version })
      .from(stages)
      .where(eq(stages.stageId, stageId))
      .limit(1);
    return row ? Number(row.version) : null;
  }

  async listByRun(runId: string): Promise<Stage[]> {
    const rows = await this.db
      .select()
      .from(stages)
      .where(eq(stages.runId, runId));

    return rows.map(fromStageRow);
  }

  private async rejectWrite(
    stageId: string,
    stageRunId: string | null,
    options: WriteOptions,
  ): Promise<never> {
    const currentVersion = await this.getVersion(stageId).catch(() => null);
    const detail = conflictDetail("stage", stageId, options, currentVersion);
    let runId = stageRunId;
    if (!runId) {
      try {
        const [row] = await this.db
          .select({ runId: stages.runId })
          .from(stages)
          .where(eq(stages.stageId, stageId))
          .limit(1);
        runId = row?.runId ?? null;
      } catch {
        runId = null;
      }
    }
    let workspaceId: string | null = null;
    if (runId) {
      try {
        const [row] = await this.db
          .select({ workspaceId: runs.workspaceId })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        workspaceId = row?.workspaceId ?? null;
      } catch {
        workspaceId = null;
      }
    }
    await recordWriteConflict(this.opLog, detail, {
      workspaceId,
      actor: options.lease?.owner ?? "engine",
    });
    throw new VersionConflictError(detail);
  }
}

export class PostgresManifestStore implements ManifestStore {
  constructor(private readonly db: Database) {}

  async put(manifest: Manifest): Promise<void> {
    await this.db.insert(manifests).values(toManifestRow(manifest));
  }

  async get(manifestId: string): Promise<Manifest | null> {
    const [row] = await this.db
      .select()
      .from(manifests)
      .where(eq(manifests.manifestId, manifestId))
      .limit(1);

    return row ? fromManifestRow(row) : null;
  }
}

export class PostgresBlobRepository implements BlobRepository {
  constructor(private readonly db: Database) {}

  async findById(blobId: string): Promise<Blob | null> {
    const [row] = await this.db
      .select()
      .from(blobs)
      .where(eq(blobs.blobId, blobId))
      .limit(1);

    return row ? fromBlobRow(row) : null;
  }

  async find(workspaceId: string, sha256: string): Promise<Blob | null> {
    const [row] = await this.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.workspaceId, workspaceId), eq(blobs.sha256, sha256)))
      .limit(1);

    return row ? fromBlobRow(row) : null;
  }

  async insert(blob: Blob): Promise<boolean> {
    const rows = await this.db
      .insert(blobs)
      .values(toBlobRow(blob))
      .onConflictDoNothing()
      .returning({ blobId: blobs.blobId });

    return rows.length > 0;
  }
}

export class PostgresArtifactStore implements ArtifactStore {
  constructor(private readonly db: Database) {}

  async createCommitted(
    manifest: Manifest,
    artifact: ArtifactVersion,
  ): Promise<void> {
    const { rows } = buildArtifactEdgeRows(artifact, manifest.inputs);
    await this.db.transaction(async (tx) => {
      await tx.insert(manifests).values(toManifestRow(manifest));
      await tx.insert(artifacts).values(toArtifactRow(artifact));
      if (rows.length > 0) {
        await tx.insert(artifactEdges).values(rows).onConflictDoNothing();
      }
    });
  }

  async putVersion(artifact: ArtifactVersion): Promise<void> {
    const [manifestRow] = await this.db
      .select({ inputRefs: manifests.inputRefs })
      .from(manifests)
      .where(eq(manifests.manifestId, artifact.manifestId))
      .limit(1);
    const { rows } = buildArtifactEdgeRows(
      artifact,
      manifestRow?.inputRefs ?? [],
    );
    await this.db.transaction(async (tx) => {
      await tx
        .insert(artifacts)
        .values(toArtifactRow(artifact))
        .onConflictDoNothing();
      if (rows.length > 0) {
        await tx.insert(artifactEdges).values(rows).onConflictDoNothing();
      }
    });
  }

  async commit(artifactId: string, version: number): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ status: "committed" })
      .where(
        and(
          eq(artifacts.artifactId, artifactId),
          eq(artifacts.version, version),
        ),
      );
  }

  async findById(
    artifactId: string,
    version = 1,
  ): Promise<ArtifactVersion | null> {
    const [row] = await this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.artifactId, artifactId),
          eq(artifacts.version, version),
        ),
      )
      .limit(1);

    return row ? fromArtifactRow(row) : null;
  }

  async findCommittedByRunStage(
    runId: string,
    stageId: string,
  ): Promise<ArtifactVersion | null> {
    const [row] = await this.db
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(manifests, eq(artifacts.manifestId, manifests.manifestId))
      .where(
        and(
          eq(manifests.runId, runId),
          eq(manifests.stageId, stageId),
          eq(artifacts.status, "committed"),
        ),
      )
      .limit(1);

    return row ? fromArtifactRow(row.artifact) : null;
  }

  async listByRun(runId: string): Promise<ArtifactVersion[]> {
    const rows = await this.db
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(manifests, eq(artifacts.manifestId, manifests.manifestId))
      .where(
        and(eq(manifests.runId, runId), eq(artifacts.status, "committed")),
      );

    return rows.map((row) => fromArtifactRow(row.artifact));
  }

  async listRecent(
    workspaceId: string,
    limit = 10,
  ): Promise<ArtifactVersion[]> {
    const rows = await this.db
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(manifests, eq(artifacts.manifestId, manifests.manifestId))
      .where(
        and(
          eq(artifacts.workspaceId, workspaceId),
          eq(artifacts.status, "committed"),
        ),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(limit);

    return rows.map((row) => fromArtifactRow(row.artifact));
  }

  async consumersOf(
    artifactId: string,
    version: number,
  ): Promise<ArtifactVersionRef[]> {
    const rows = await this.db
      .select({
        artifactId: artifactEdges.fromId,
        version: artifactEdges.fromVersion,
      })
      .from(artifactEdges)
      .where(
        and(
          eq(artifactEdges.toKind, ARTIFACT_KIND),
          eq(artifactEdges.toId, artifactId),
          eq(artifactEdges.toVersion, version),
          eq(artifactEdges.relation, "consumed"),
        ),
      )
      .orderBy(asc(artifactEdges.createdAt));

    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = artifactVersionKey(row);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async ancestryOf(
    artifactId: string,
    version: number,
    options: { maxDepth?: number } = {},
  ): Promise<ArtifactAncestryNode[]> {
    return collectArtifactAncestry(
      { artifactId, version },
      (frontier) => this.findOutgoingEdges(frontier),
      options.maxDepth,
    );
  }

  async backfillEdges(): Promise<ArtifactEdgeBackfillResult> {
    const manifestRows = await this.db
      .select({
        manifestId: manifests.manifestId,
        inputRefs: manifests.inputRefs,
      })
      .from(manifests);
    const artifactRows = await this.db.select().from(artifacts);
    const inputsByManifest = new Map(
      manifestRows.map((row) => [row.manifestId, row.inputRefs]),
    );

    const rows: ArtifactEdgeRow[] = [];
    let skipped = 0;
    for (const row of artifactRows) {
      const artifact = fromArtifactRow(row);
      const built = buildArtifactEdgeRows(
        artifact,
        inputsByManifest.get(artifact.manifestId) ?? [],
      );
      rows.push(...built.rows);
      skipped += built.skipped;
    }

    let inserted = 0;
    for (const chunk of chunkArtifactEdgeRows(rows, 500)) {
      const result = await this.db
        .insert(artifactEdges)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ edgeId: artifactEdges.edgeId });
      inserted += result.length;
    }
    return { inserted, skipped };
  }

  private async findOutgoingEdges(
    frontier: ArtifactVersionRef[],
  ): Promise<ArtifactEdgeLink[]> {
    const keys = new Set(frontier.map(artifactVersionKey));
    const ids = [...new Set(frontier.map((ref) => ref.artifactId))];
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({
        fromId: artifactEdges.fromId,
        fromVersion: artifactEdges.fromVersion,
        toId: artifactEdges.toId,
        toVersion: artifactEdges.toVersion,
        relation: artifactEdges.relation,
      })
      .from(artifactEdges)
      .where(
        and(
          eq(artifactEdges.fromKind, ARTIFACT_KIND),
          inArray(artifactEdges.fromId, ids),
        ),
      );

    return rows
      .filter((row) =>
        keys.has(
          artifactVersionKey({
            artifactId: row.fromId,
            version: row.fromVersion,
          }),
        ),
      )
      .map((row) => ({
        from: { artifactId: row.fromId, version: row.fromVersion },
        to: { artifactId: row.toId, version: row.toVersion },
        relation: row.relation as ArtifactEdgeRelation,
      }));
  }
}

export class PostgresLastKnownGoodStore implements LastKnownGoodStore {
  constructor(private readonly db: Database) {}

  async get(lkgId: string): Promise<LastKnownGood | null> {
    const [row] = await this.db
      .select()
      .from(lastKnownGood)
      .where(eq(lastKnownGood.lkgId, lkgId))
      .limit(1);
    return row ? fromLastKnownGoodRow(row) : null;
  }

  async listActive(workspaceId?: string): Promise<LastKnownGood[]> {
    const rows = await this.db
      .select()
      .from(lastKnownGood)
      .where(
        workspaceId
          ? and(
              eq(lastKnownGood.status, "active"),
              eq(lastKnownGood.workspaceId, workspaceId),
            )
          : eq(lastKnownGood.status, "active"),
      )
      .orderBy(desc(lastKnownGood.verifiedAt));
    return rows.map(fromLastKnownGoodRow);
  }

  async history(
    workspaceId: string,
    targetKey: string,
    limit = 50,
  ): Promise<LastKnownGood[]> {
    const rows = await this.db
      .select()
      .from(lastKnownGood)
      .where(
        and(
          eq(lastKnownGood.workspaceId, workspaceId),
          eq(lastKnownGood.targetKey, targetKey),
        ),
      )
      .orderBy(desc(lastKnownGood.createdAt))
      .limit(Math.max(1, Math.min(limit, 200)));
    return rows.map(fromLastKnownGoodRow);
  }

  async switch(record: LastKnownGood): Promise<LastKnownGoodSwitch> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(lastKnownGood)
        .where(eq(lastKnownGood.lkgId, record.lkgId))
        .limit(1);
      if (existing) {
        return {
          record: fromLastKnownGoodRow(existing),
          previous: [],
          changed: false,
        };
      }

      const activeRows = await tx
        .select()
        .from(lastKnownGood)
        .where(
          and(
            eq(lastKnownGood.workspaceId, record.workspaceId),
            eq(lastKnownGood.targetKey, record.targetKey),
            eq(lastKnownGood.status, "active"),
          ),
        );
      const transition = switchLastKnownGood({
        previous: activeRows.map(fromLastKnownGoodRow),
        next: record,
      });
      for (const previous of transition.previous) {
        await tx
          .update(lastKnownGood)
          .set({
            status: "superseded",
            supersededBy: transition.next.lkgId,
          })
          .where(eq(lastKnownGood.lkgId, previous.lkgId));
      }
      const [inserted] = await tx
        .insert(lastKnownGood)
        .values(toLastKnownGoodRow(transition.next))
        .returning();
      if (!inserted) {
        throw new Error("failed to insert last-known-good");
      }
      return {
        record: fromLastKnownGoodRow(inserted),
        previous: transition.previous,
        changed: true,
      };
    });
  }
}

export function toAutopilotRow(record: AutopilotStateRecord) {
  return {
    workspaceId: record.workspaceId,
    packDir: record.packDir,
    enabled: record.enabled,
    lastTickAt: record.lastTickAt,
    nextRuns: record.nextRuns,
    day: record.day,
    runsToday: record.runsToday,
    spentToday: String(record.spentToday),
    lastError: record.lastError,
    updatedAt: record.updatedAt,
    version: record.version ?? 0,
  };
}

export function fromAutopilotRow(
  row: typeof autopilotState.$inferSelect,
): AutopilotStateRecord {
  return {
    workspaceId: row.workspaceId,
    packDir: row.packDir,
    enabled: Boolean(row.enabled),
    lastTickAt: row.lastTickAt ?? null,
    nextRuns: row.nextRuns ?? {},
    day: row.day ?? null,
    runsToday: Number(row.runsToday ?? 0),
    spentToday: Number(row.spentToday ?? 0),
    lastError: row.lastError ?? null,
    updatedAt: row.updatedAt,
    version: Number(row.version ?? 0),
  };
}

export function nextManagerSessionWindow(
  existing: ManagerSessionRecord | null,
  input: {
    workspaceId: string;
    sessionId: string;
    now: string;
    windowMs: number;
  },
): ManagerSessionRecord {
  if (existing && Date.parse(input.now) < Date.parse(existing.windowEndsAt)) {
    return { ...existing };
  }
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    windowStartedAt: input.now,
    windowEndsAt: new Date(
      Date.parse(input.now) + Math.max(0, input.windowMs),
    ).toISOString(),
    firstAt: input.now,
    lastAt: input.now,
    tokens: 0,
    costCny: 0,
    exchanges: 0,
    rejections: 0,
    lastRejectionReason: null,
    updatedAt: input.now,
  };
}

export function applyManagerSessionUsage(
  existing: ManagerSessionRecord | null,
  input: ManagerSessionUsageInput,
): ManagerSessionRecord {
  const record = nextManagerSessionWindow(existing, input);
  record.tokens += Math.max(0, input.tokens);
  record.costCny += Math.max(0, input.costCny);
  record.exchanges += 1;
  record.lastAt = input.now;
  record.updatedAt = input.now;
  return record;
}

export function applyManagerSessionRejection(
  existing: ManagerSessionRecord | null,
  input: ManagerSessionRejectionInput,
): ManagerSessionRecord {
  const record = nextManagerSessionWindow(existing, input);
  record.rejections += 1;
  record.lastRejectionReason = input.reason;
  record.lastAt = input.now;
  record.updatedAt = input.now;
  return record;
}

export function toManagerSessionRow(record: ManagerSessionRecord) {
  return {
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    windowStartedAt: record.windowStartedAt,
    windowEndsAt: record.windowEndsAt,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
    tokens: record.tokens,
    costCny: String(record.costCny),
    exchanges: record.exchanges,
    rejections: record.rejections,
    lastRejectionReason: record.lastRejectionReason,
    updatedAt: record.updatedAt,
  };
}

export function fromManagerSessionRow(
  row: typeof managerSessions.$inferSelect,
): ManagerSessionRecord {
  return {
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    windowStartedAt: row.windowStartedAt,
    windowEndsAt: row.windowEndsAt,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    tokens: Number(row.tokens ?? 0),
    costCny: Number(row.costCny ?? 0),
    exchanges: Number(row.exchanges ?? 0),
    rejections: Number(row.rejections ?? 0),
    lastRejectionReason: row.lastRejectionReason ?? null,
    updatedAt: row.updatedAt,
  };
}

function managerSessionUpdateSet(record: ManagerSessionRecord) {
  return {
    windowStartedAt: record.windowStartedAt,
    windowEndsAt: record.windowEndsAt,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
    tokens: record.tokens,
    costCny: String(record.costCny),
    exchanges: record.exchanges,
    rejections: record.rejections,
    lastRejectionReason: record.lastRejectionReason,
    updatedAt: record.updatedAt,
  };
}

export class PostgresAutopilotStateStore implements AutopilotStateStore {
  constructor(private readonly db: Database) {}

  async get(
    workspaceId: string,
    packDir: string,
  ): Promise<AutopilotStateRecord | null> {
    const [row] = await this.db
      .select()
      .from(autopilotState)
      .where(
        and(
          eq(autopilotState.workspaceId, workspaceId),
          eq(autopilotState.packDir, packDir),
        ),
      )
      .limit(1);
    return row ? fromAutopilotRow(row) : null;
  }

  async list(workspaceId: string): Promise<AutopilotStateRecord[]> {
    const rows = await this.db
      .select()
      .from(autopilotState)
      .where(eq(autopilotState.workspaceId, workspaceId))
      .orderBy(asc(autopilotState.packDir));
    return rows.map(fromAutopilotRow);
  }

  async insertIfMissing(record: AutopilotStateRecord): Promise<void> {
    await this.db
      .insert(autopilotState)
      .values(toAutopilotRow(record))
      .onConflictDoNothing();
  }

  async update(record: AutopilotStateRecord): Promise<boolean> {
    const rows = await this.db
      .update(autopilotState)
      .set({
        enabled: record.enabled,
        lastTickAt: record.lastTickAt,
        nextRuns: record.nextRuns,
        day: record.day,
        runsToday: record.runsToday,
        spentToday: String(record.spentToday),
        lastError: record.lastError,
        updatedAt: record.updatedAt,
        version: sql`${autopilotState.version} + 1`,
      })
      .where(
        and(
          eq(autopilotState.workspaceId, record.workspaceId),
          eq(autopilotState.packDir, record.packDir),
          eq(autopilotState.version, record.version ?? 0),
        ),
      )
      .returning({ version: autopilotState.version });
    const row = rows[0];
    if (!row) {
      return false;
    }
    record.version = Number(row.version);
    return true;
  }
}

export class PostgresManagerSessionStore implements ManagerSessionStore {
  constructor(private readonly db: Database) {}

  async get(
    workspaceId: string,
    sessionId: string,
  ): Promise<ManagerSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(managerSessions)
      .where(
        and(
          eq(managerSessions.workspaceId, workspaceId),
          eq(managerSessions.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ? fromManagerSessionRow(row) : null;
  }

  async addUsage(
    input: ManagerSessionUsageInput,
  ): Promise<ManagerSessionRecord> {
    const existing = await this.get(input.workspaceId, input.sessionId);
    const record = applyManagerSessionUsage(existing, input);
    await this.db
      .insert(managerSessions)
      .values(toManagerSessionRow(record))
      .onConflictDoUpdate({
        target: [managerSessions.workspaceId, managerSessions.sessionId],
        set: managerSessionUpdateSet(record),
      });
    return record;
  }

  async recordRejection(
    input: ManagerSessionRejectionInput,
  ): Promise<ManagerSessionRecord> {
    const existing = await this.get(input.workspaceId, input.sessionId);
    const record = applyManagerSessionRejection(existing, input);
    await this.db
      .insert(managerSessions)
      .values(toManagerSessionRow(record))
      .onConflictDoUpdate({
        target: [managerSessions.workspaceId, managerSessions.sessionId],
        set: managerSessionUpdateSet(record),
      });
    return record;
  }

  async reset(workspaceId: string, sessionId: string): Promise<void> {
    await this.db
      .delete(managerSessions)
      .where(
        and(
          eq(managerSessions.workspaceId, workspaceId),
          eq(managerSessions.sessionId, sessionId),
        ),
      );
  }
}

export function fromRunRequestRow(
  row: typeof runRequests.$inferSelect,
): RunRequestRecord {
  return {
    requestId: row.requestId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    kind: row.kind as RunRequestRecord["kind"],
    payload: row.payload,
    status: row.status as RunRequestRecord["status"],
    claimedBy: row.claimedBy ?? null,
    claimedAt: row.claimedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    leaseVersion: Number(row.leaseVersion ?? 0),
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresRunRequestStore implements RunRequestStore {
  constructor(
    private readonly db: Database,
    private readonly opLog?: OpLogStore,
  ) {}

  async enqueue(
    record: Parameters<RunRequestStore["enqueue"]>[0],
  ): Promise<void> {
    await this.db
      .insert(runRequests)
      .values({
        requestId: record.requestId,
        runId: record.runId,
        workspaceId: record.workspaceId,
        workflowId: record.workflowId,
        kind: record.kind,
        payload: record.payload,
        status: "queued",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        leaseVersion: 0,
        error: null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoNothing();
  }

  async claimNext(
    owner: string,
    now: Date,
    staleMs: number,
  ): Promise<RunRequestRecord | null> {
    const staleIso = new Date(now.getTime() - staleMs).toISOString();
    const nowIso = now.toISOString();
    const claimable = () =>
      or(
        eq(runRequests.status, "queued"),
        and(
          eq(runRequests.status, "claimed"),
          lt(runRequests.heartbeatAt, staleIso),
        ),
      );

    const candidates = await this.db
      .select({ requestId: runRequests.requestId })
      .from(runRequests)
      .where(claimable())
      .orderBy(asc(runRequests.createdAt))
      .limit(5);

    for (const candidate of candidates) {
      const [row] = await this.db
        .update(runRequests)
        .set({
          status: "claimed",
          claimedBy: owner,
          claimedAt: nowIso,
          heartbeatAt: nowIso,
          leaseVersion: sql`${runRequests.leaseVersion} + 1`,
          updatedAt: nowIso,
        })
        .where(and(eq(runRequests.requestId, candidate.requestId), claimable()))
        .returning();
      if (row) {
        return fromRunRequestRow(row);
      }
    }
    return null;
  }

  async heartbeat(
    requestId: string,
    owner: string,
    now: Date,
    expectedLeaseVersion?: number,
  ): Promise<RunRequestRecord | null> {
    const nowIso = now.toISOString();
    const conditions: SQL[] = [
      eq(runRequests.requestId, requestId),
      eq(runRequests.claimedBy, owner),
    ];
    if (expectedLeaseVersion !== undefined) {
      conditions.push(eq(runRequests.leaseVersion, expectedLeaseVersion));
    }
    const [row] = await this.db
      .update(runRequests)
      .set({ heartbeatAt: nowIso, updatedAt: nowIso })
      .where(and(...conditions))
      .returning();
    if (!row) {
      if (expectedLeaseVersion !== undefined) {
        await this.rejectLease(
          requestId,
          owner,
          expectedLeaseVersion,
          "lease_mismatch",
        );
      }
      return null;
    }
    return fromRunRequestRow(row);
  }

  async finish(
    requestId: string,
    status: "done" | "failed" | "cancelled",
    error?: string,
    lease?: Pick<WriteLease, "owner" | "leaseVersion">,
  ): Promise<void> {
    const conditions: SQL[] = [eq(runRequests.requestId, requestId)];
    if (lease) {
      conditions.push(eq(runRequests.claimedBy, lease.owner));
      conditions.push(eq(runRequests.leaseVersion, lease.leaseVersion));
    }
    const rows = await this.db
      .update(runRequests)
      .set({
        status,
        error: error ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(...conditions))
      .returning({ requestId: runRequests.requestId });
    if (rows.length === 0 && lease) {
      await this.rejectLease(
        requestId,
        lease.owner,
        lease.leaseVersion,
        "lease_mismatch",
      );
    }
  }

  async find(runId: string): Promise<RunRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.runId, runId))
      .limit(1);
    return row ? fromRunRequestRow(row) : null;
  }

  private async rejectLease(
    requestId: string,
    owner: string,
    leaseVersion: number,
    reason: "lease_mismatch",
  ): Promise<never> {
    let workspaceId: string | null = null;
    let currentVersion: number | null = null;
    try {
      const [row] = await this.db
        .select({
          workspaceId: runRequests.workspaceId,
          leaseVersion: runRequests.leaseVersion,
        })
        .from(runRequests)
        .where(eq(runRequests.requestId, requestId))
        .limit(1);
      workspaceId = row?.workspaceId ?? null;
      currentVersion = row ? Number(row.leaseVersion) : null;
    } catch {
      workspaceId = null;
    }
    const detail: WriteConflictDetail = {
      entityKind: "run_request",
      entityId: requestId,
      reason,
      leaseVersion,
      owner,
      requestId,
      currentVersion,
    };
    await recordWriteConflict(this.opLog, detail, {
      workspaceId,
      actor: owner,
    });
    throw new VersionConflictError(detail);
  }
}

export interface DegradationStateRecord {
  scope: DegradationScope;
  workspaceId: string;
  modeId: string;
  kind: DegradedModeKind;
  triggers: DegradationTrigger[];
  behavior: string;
  qualityFloor: QualityFloor;
  exitCriteria: ExitCriteria;
  status: DegradedModeStatus;
  enteredAt: string;
  enteredBy: string;
  exitedAt: string | null;
  exitReason: string | null;
}

export interface DegradationAuditRecord {
  auditId: string;
  occurredAt: string;
  actor: string;
  action: DegradationAuditAction;
  scope: DegradationScope;
  workspaceId: string;
  modeId: string;
  detail: Record<string, unknown>;
}

export interface DegradationStore {
  get(
    scope: DegradationScope,
    workspaceId: string,
  ): Promise<DegradationStateRecord | null>;
  listActive(): Promise<DegradationStateRecord[]>;
  upsert(record: DegradationStateRecord): Promise<void>;
  markExited(
    scope: DegradationScope,
    workspaceId: string,
    exitedAt: string,
    exitReason: string,
  ): Promise<boolean>;
  appendAudit(record: DegradationAuditRecord): Promise<void>;
  listAudit(limit?: number): Promise<DegradationAuditRecord[]>;
}

export function toDegradationRow(record: DegradationStateRecord) {
  return {
    scope: record.scope,
    workspaceId: record.workspaceId,
    modeId: record.modeId,
    kind: record.kind,
    triggers: record.triggers,
    behavior: record.behavior,
    qualityFloor: record.qualityFloor,
    exitCriteria: record.exitCriteria,
    status: record.status,
    enteredAt: record.enteredAt,
    enteredBy: record.enteredBy,
    exitedAt: record.exitedAt,
    exitReason: record.exitReason,
  };
}

export function fromDegradationRow(
  row: typeof degradationState.$inferSelect,
): DegradationStateRecord {
  return {
    scope: row.scope as DegradationScope,
    workspaceId: row.workspaceId,
    modeId: row.modeId,
    kind: row.kind as DegradedModeKind,
    triggers: row.triggers,
    behavior: row.behavior,
    qualityFloor: row.qualityFloor,
    exitCriteria: row.exitCriteria,
    status: row.status as DegradedModeStatus,
    enteredAt: row.enteredAt,
    enteredBy: row.enteredBy,
    exitedAt: row.exitedAt ?? null,
    exitReason: row.exitReason ?? null,
  };
}

export function toDegradationAuditRow(record: DegradationAuditRecord) {
  return {
    auditId: record.auditId,
    occurredAt: record.occurredAt,
    actor: record.actor,
    action: record.action,
    scope: record.scope,
    workspaceId: record.workspaceId,
    modeId: record.modeId,
    detail: record.detail,
  };
}

export function fromDegradationAuditRow(
  row: typeof degradationAudit.$inferSelect,
): DegradationAuditRecord {
  return {
    auditId: row.auditId,
    occurredAt: row.occurredAt,
    actor: row.actor,
    action: row.action as DegradationAuditAction,
    scope: row.scope as DegradationScope,
    workspaceId: row.workspaceId,
    modeId: row.modeId,
    detail: row.detail,
  };
}

export class PostgresDegradationStore implements DegradationStore {
  constructor(private readonly db: Database) {}

  async get(
    scope: DegradationScope,
    workspaceId: string,
  ): Promise<DegradationStateRecord | null> {
    const [row] = await this.db
      .select()
      .from(degradationState)
      .where(
        and(
          eq(degradationState.scope, scope),
          eq(degradationState.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ? fromDegradationRow(row) : null;
  }

  async listActive(): Promise<DegradationStateRecord[]> {
    const rows = await this.db
      .select()
      .from(degradationState)
      .where(eq(degradationState.status, "active"))
      .orderBy(desc(degradationState.enteredAt));
    return rows.map(fromDegradationRow);
  }

  async upsert(record: DegradationStateRecord): Promise<void> {
    const values = toDegradationRow(record);
    await this.db
      .insert(degradationState)
      .values(values)
      .onConflictDoUpdate({
        target: [degradationState.scope, degradationState.workspaceId],
        set: values,
      });
  }

  async markExited(
    scope: DegradationScope,
    workspaceId: string,
    exitedAt: string,
    exitReason: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(degradationState)
      .set({ status: "exited", exitedAt, exitReason })
      .where(
        and(
          eq(degradationState.scope, scope),
          eq(degradationState.workspaceId, workspaceId),
          eq(degradationState.status, "active"),
        ),
      )
      .returning({ modeId: degradationState.modeId });
    return rows.length > 0;
  }

  async appendAudit(record: DegradationAuditRecord): Promise<void> {
    await this.db
      .insert(degradationAudit)
      .values(toDegradationAuditRow(record))
      .onConflictDoNothing();
  }

  async listAudit(limit = 50): Promise<DegradationAuditRecord[]> {
    const rows = await this.db
      .select()
      .from(degradationAudit)
      .orderBy(desc(degradationAudit.occurredAt))
      .limit(limit);
    return rows.map(fromDegradationAuditRow);
  }
}

interface KillSwitchRowLike {
  switchId: string;
  scope: string;
  target: string;
  workspaceId: string;
  state: string;
  activatedBy: string;
  reason: string;
  activatedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  version: number;
  updatedAt: string;
}

export function toKillSwitchRow(record: KillSwitch) {
  return {
    switchId: record.switchId,
    scope: record.scope,
    target: record.target,
    workspaceId: record.workspaceId ?? "",
    state: record.state,
    activatedBy: record.activatedBy,
    reason: record.reason,
    activatedAt: record.activatedAt,
    releasedBy: record.releasedBy,
    releasedAt: record.releasedAt,
    releaseReason: record.releaseReason,
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

export function fromKillSwitchRow(row: KillSwitchRowLike): KillSwitch {
  return {
    switchId: row.switchId,
    scope: row.scope as KillSwitch["scope"],
    target: row.target,
    workspaceId: row.workspaceId.length > 0 ? row.workspaceId : null,
    state: row.state as KillSwitch["state"],
    activatedBy: row.activatedBy,
    reason: row.reason,
    activatedAt: row.activatedAt,
    releasedBy: row.releasedBy ?? null,
    releasedAt: row.releasedAt ?? null,
    releaseReason: row.releaseReason ?? null,
    version: Number(row.version),
    updatedAt: row.updatedAt,
  };
}

export class PostgresKillSwitchStore implements KillSwitchStore {
  constructor(private readonly db: Database) {}

  private identity(
    record: Pick<KillSwitch, "scope" | "target" | "workspaceId">,
  ) {
    return and(
      eq(killSwitches.scope, record.scope),
      eq(killSwitches.target, record.target),
      eq(killSwitches.workspaceId, record.workspaceId ?? ""),
    );
  }

  async activate(record: KillSwitch): Promise<KillSwitchActivation> {
    const [existing] = await this.db
      .select()
      .from(killSwitches)
      .where(this.identity(record))
      .limit(1);

    if (existing) {
      if (existing.state === "active") {
        return { record: fromKillSwitchRow(existing), changed: false };
      }
      const [updated] = await this.db
        .update(killSwitches)
        .set({
          state: "active",
          activatedBy: record.activatedBy,
          reason: record.reason,
          activatedAt: record.activatedAt,
          releasedBy: null,
          releasedAt: null,
          releaseReason: null,
          updatedAt: record.updatedAt,
          version: sql`${killSwitches.version} + 1`,
        })
        .where(
          and(
            eq(killSwitches.switchId, existing.switchId),
            eq(killSwitches.state, "released"),
          ),
        )
        .returning();
      if (updated) {
        return { record: fromKillSwitchRow(updated), changed: true };
      }
      const [current] = await this.db
        .select()
        .from(killSwitches)
        .where(eq(killSwitches.switchId, existing.switchId))
        .limit(1);
      return {
        record: fromKillSwitchRow(current ?? existing),
        changed: false,
      };
    }

    const [inserted] = await this.db
      .insert(killSwitches)
      .values(toKillSwitchRow(record))
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { record: fromKillSwitchRow(inserted), changed: true };
    }
    const [raced] = await this.db
      .select()
      .from(killSwitches)
      .where(this.identity(record))
      .limit(1);
    if (!raced) {
      throw new Error("failed to activate kill switch");
    }
    return { record: fromKillSwitchRow(raced), changed: false };
  }

  async release(
    switchId: string,
    releasedBy: string,
    releaseReason: string,
    releasedAt: string,
  ): Promise<KillSwitchActivation | null> {
    const [updated] = await this.db
      .update(killSwitches)
      .set({
        state: "released",
        releasedBy,
        releaseReason,
        releasedAt,
        updatedAt: releasedAt,
        version: sql`${killSwitches.version} + 1`,
      })
      .where(
        and(
          eq(killSwitches.switchId, switchId),
          eq(killSwitches.state, "active"),
        ),
      )
      .returning();
    if (updated) {
      return { record: fromKillSwitchRow(updated), changed: true };
    }
    const existing = await this.get(switchId);
    return existing ? { record: existing, changed: false } : null;
  }

  async get(switchId: string): Promise<KillSwitch | null> {
    const [row] = await this.db
      .select()
      .from(killSwitches)
      .where(eq(killSwitches.switchId, switchId))
      .limit(1);
    return row ? fromKillSwitchRow(row) : null;
  }

  async listActive(): Promise<KillSwitch[]> {
    const rows = await this.db
      .select()
      .from(killSwitches)
      .where(eq(killSwitches.state, "active"))
      .orderBy(asc(killSwitches.scope), desc(killSwitches.activatedAt));
    return rows.map(fromKillSwitchRow);
  }

  async list(limit = 50): Promise<KillSwitch[]> {
    const rows = await this.db
      .select()
      .from(killSwitches)
      .orderBy(desc(killSwitches.updatedAt))
      .limit(Math.max(1, Math.min(limit, 200)));
    return rows.map(fromKillSwitchRow);
  }
}

// ---------------------------------------------------------------------------
// Incident / Runbook / Drills (61 §2, §3.4, §5)
// ---------------------------------------------------------------------------

export interface IncidentListOptions {
  status?: Incident["status"];
  limit?: number;
}

export interface RunbookListOptions {
  modeId?: string;
  status?: Runbook["status"];
  limit?: number;
}

export interface IncidentStore {
  create(incident: Incident): Promise<void>;
  get(incidentId: string): Promise<Incident | null>;
  list(
    workspaceId: string,
    options?: IncidentListOptions,
  ): Promise<Incident[]>;
  /** Optimistic update; returns false and mutates nothing on version conflict. */
  update(incident: Incident): Promise<boolean>;
}

export interface RunbookStore {
  /** Inserts a new runbook or replaces one with the same id. */
  upsert(runbook: Runbook): Promise<void>;
  get(runbookId: string): Promise<Runbook | null>;
  list(
    workspaceId: string,
    options?: RunbookListOptions,
  ): Promise<Runbook[]>;
  /** Optimistic update; returns false on version conflict. */
  update(runbook: Runbook): Promise<boolean>;
}

export interface DrillStore {
  recordRunbookDrill(drill: RunbookDrill): Promise<void>;
  listRunbookDrills(runbookId: string, limit?: number): Promise<RunbookDrill[]>;
  listRunbookDrillsByWorkspace(
    workspaceId: string,
    limit?: number,
  ): Promise<RunbookDrill[]>;
  recordRecoveryDrill(drill: RecoveryDrill): Promise<void>;
  listRecoveryDrills(limit?: number): Promise<RecoveryDrill[]>;
  latestRecoveryDrill(): Promise<RecoveryDrill | null>;
}

export function toIncidentRow(record: Incident) {
  return {
    incidentId: record.incidentId,
    workspaceId: record.workspaceId,
    title: record.title,
    severity: record.severity,
    detectedAt: record.detectedAt,
    status: record.status,
    owner: record.owner,
    timeline: record.timeline,
    postmortem: record.postmortem,
    degradationModeId: record.degradationModeId,
    regressionCaseRef: record.regressionCaseRef,
    evolutionSignalRef: record.evolutionSignalRef,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version ?? 0,
  };
}

export function fromIncidentRow(
  row: typeof incidents.$inferSelect,
): Incident {
  return {
    incidentId: row.incidentId,
    workspaceId: row.workspaceId,
    title: row.title,
    severity: row.severity,
    detectedAt: row.detectedAt,
    status: row.status,
    owner: row.owner,
    timeline: row.timeline,
    postmortem: row.postmortem,
    degradationModeId: row.degradationModeId ?? null,
    regressionCaseRef: row.regressionCaseRef ?? null,
    evolutionSignalRef: row.evolutionSignalRef ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: Number(row.version ?? 0),
  };
}

export function toRunbookRow(record: Runbook) {
  return {
    runbookId: record.runbookId,
    workspaceId: record.workspaceId,
    modeId: record.modeId,
    trigger: record.trigger,
    steps: record.steps,
    owner: record.owner,
    verification: record.verification,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version ?? 0,
  };
}

export function fromRunbookRow(row: typeof runbooks.$inferSelect): Runbook {
  return {
    runbookId: row.runbookId,
    workspaceId: row.workspaceId,
    modeId: row.modeId,
    trigger: row.trigger,
    steps: row.steps,
    owner: row.owner,
    verification: row.verification,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: Number(row.version ?? 0),
  };
}

export function toRunbookDrillRow(record: RunbookDrill) {
  return {
    drillId: record.drillId,
    workspaceId: record.workspaceId,
    runbookId: record.runbookId,
    modeId: record.modeId,
    executedAt: record.executedAt,
    executedBy: record.executedBy,
    outcome: record.outcome,
    notes: record.notes,
    createdAt: record.createdAt,
  };
}

export function fromRunbookDrillRow(
  row: typeof runbookDrills.$inferSelect,
): RunbookDrill {
  return {
    drillId: row.drillId,
    workspaceId: row.workspaceId,
    runbookId: row.runbookId,
    modeId: row.modeId,
    executedAt: row.executedAt,
    executedBy: row.executedBy,
    outcome: row.outcome,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

export function toRecoveryDrillRow(record: RecoveryDrill) {
  return {
    drillId: record.drillId,
    executedAt: record.executedAt,
    executedBy: record.executedBy,
    script: record.script,
    rtoTargetMinutes: record.rtoTargetMinutes,
    rpoTargetMinutes: record.rpoTargetMinutes,
    measuredRtoMinutes: record.measuredRtoMinutes,
    measuredRpoMinutes: record.measuredRpoMinutes,
    kitdRollbackRef: record.kitdRollbackRef,
    integrityPass: record.integrityPass,
    outcome: record.outcome,
    notes: record.notes,
    createdAt: record.createdAt,
  };
}

export function fromRecoveryDrillRow(
  row: typeof recoveryDrills.$inferSelect,
): RecoveryDrill {
  return {
    drillId: row.drillId,
    executedAt: row.executedAt,
    executedBy: row.executedBy,
    script: row.script,
    rtoTargetMinutes: Number(row.rtoTargetMinutes),
    rpoTargetMinutes: Number(row.rpoTargetMinutes),
    measuredRtoMinutes:
      row.measuredRtoMinutes === null ? null : Number(row.measuredRtoMinutes),
    measuredRpoMinutes:
      row.measuredRpoMinutes === null ? null : Number(row.measuredRpoMinutes),
    kitdRollbackRef: row.kitdRollbackRef ?? null,
    integrityPass: Boolean(row.integrityPass),
    outcome: row.outcome,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

export class PostgresIncidentStore implements IncidentStore {
  constructor(private readonly db: Database) {}

  async create(incident: Incident): Promise<void> {
    await this.db
      .insert(incidents)
      .values(toIncidentRow(incident))
      .onConflictDoNothing();
  }

  async get(incidentId: string): Promise<Incident | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.incidentId, incidentId))
      .limit(1);
    return row ? fromIncidentRow(row) : null;
  }

  async list(
    workspaceId: string,
    options: IncidentListOptions = {},
  ): Promise<Incident[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const conditions: SQL[] = [eq(incidents.workspaceId, workspaceId)];
    if (options.status) {
      conditions.push(eq(incidents.status, options.status));
    }
    const rows = await this.db
      .select()
      .from(incidents)
      .where(and(...conditions))
      .orderBy(desc(incidents.detectedAt))
      .limit(limit);
    return rows.map(fromIncidentRow);
  }

  async update(incident: Incident): Promise<boolean> {
    const rows = await this.db
      .update(incidents)
      .set({
        ...toIncidentRow(incident),
        version: sql`${incidents.version} + 1`,
      })
      .where(
        and(
          eq(incidents.incidentId, incident.incidentId),
          eq(incidents.version, incident.version ?? 0),
        ),
      )
      .returning({ version: incidents.version });
    const row = rows[0];
    if (!row) {
      return false;
    }
    incident.version = Number(row.version);
    return true;
  }
}

export class PostgresRunbookStore implements RunbookStore {
  constructor(private readonly db: Database) {}

  async upsert(runbook: Runbook): Promise<void> {
    const values = toRunbookRow(runbook);
    await this.db
      .insert(runbooks)
      .values(values)
      .onConflictDoUpdate({
        target: [runbooks.runbookId],
        set: values,
      });
  }

  async get(runbookId: string): Promise<Runbook | null> {
    const [row] = await this.db
      .select()
      .from(runbooks)
      .where(eq(runbooks.runbookId, runbookId))
      .limit(1);
    return row ? fromRunbookRow(row) : null;
  }

  async list(
    workspaceId: string,
    options: RunbookListOptions = {},
  ): Promise<Runbook[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const conditions: SQL[] = [eq(runbooks.workspaceId, workspaceId)];
    if (options.modeId) {
      conditions.push(eq(runbooks.modeId, options.modeId));
    }
    if (options.status) {
      conditions.push(eq(runbooks.status, options.status));
    }
    const rows = await this.db
      .select()
      .from(runbooks)
      .where(and(...conditions))
      .orderBy(asc(runbooks.modeId))
      .limit(limit);
    return rows.map(fromRunbookRow);
  }

  async update(runbook: Runbook): Promise<boolean> {
    const rows = await this.db
      .update(runbooks)
      .set({
        ...toRunbookRow(runbook),
        version: sql`${runbooks.version} + 1`,
      })
      .where(
        and(
          eq(runbooks.runbookId, runbook.runbookId),
          eq(runbooks.version, runbook.version ?? 0),
        ),
      )
      .returning({ version: runbooks.version });
    const row = rows[0];
    if (!row) {
      return false;
    }
    runbook.version = Number(row.version);
    return true;
  }
}

export class PostgresDrillStore implements DrillStore {
  constructor(private readonly db: Database) {}

  async recordRunbookDrill(drill: RunbookDrill): Promise<void> {
    await this.db
      .insert(runbookDrills)
      .values(toRunbookDrillRow(drill))
      .onConflictDoNothing();
  }

  async listRunbookDrills(
    runbookId: string,
    limit = 50,
  ): Promise<RunbookDrill[]> {
    const rows = await this.db
      .select()
      .from(runbookDrills)
      .where(eq(runbookDrills.runbookId, runbookId))
      .orderBy(desc(runbookDrills.executedAt))
      .limit(Math.max(1, Math.min(limit, 200)));
    return rows.map(fromRunbookDrillRow);
  }

  async listRunbookDrillsByWorkspace(
    workspaceId: string,
    limit = 200,
  ): Promise<RunbookDrill[]> {
    const rows = await this.db
      .select()
      .from(runbookDrills)
      .where(eq(runbookDrills.workspaceId, workspaceId))
      .orderBy(desc(runbookDrills.executedAt))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows.map(fromRunbookDrillRow);
  }

  async recordRecoveryDrill(drill: RecoveryDrill): Promise<void> {
    await this.db
      .insert(recoveryDrills)
      .values(toRecoveryDrillRow(drill))
      .onConflictDoNothing();
  }

  async listRecoveryDrills(limit = 50): Promise<RecoveryDrill[]> {
    const rows = await this.db
      .select()
      .from(recoveryDrills)
      .orderBy(desc(recoveryDrills.executedAt))
      .limit(Math.max(1, Math.min(limit, 200)));
    return rows.map(fromRecoveryDrillRow);
  }

  async latestRecoveryDrill(): Promise<RecoveryDrill | null> {
    const [row] = await this.db
      .select()
      .from(recoveryDrills)
      .orderBy(desc(recoveryDrills.executedAt))
      .limit(1);
    return row ? fromRecoveryDrillRow(row) : null;
  }
}
