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
  Manifest,
  QualityFloor,
  Run,
  RunMode,
  RunStatus,
  Sensitivity,
  Stage,
  StageStatus,
} from "@kit/core";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "./db";
import {
  events,
  artifacts,
  autopilotState,
  blobs,
  degradationAudit,
  degradationState,
  managerSessions,
  manifests,
  runRequests,
  runs,
  stages,
} from "./schema";

export interface EventStore {
  insert(event: EventEnvelope): Promise<{ inserted: boolean }>;
  findByIdempotencyKey(key: string): Promise<EventEnvelope | null>;
}

export interface RunStore {
  create(run: Run): Promise<void>;
  updateStatus(
    runId: string,
    status: Run["status"],
    updatedAt: string,
  ): Promise<void>;
  get(runId: string): Promise<Run | null>;
  listRecent(limit?: number): Promise<Run[]>;
  list(options?: {
    status?: RunStatus;
    limit?: number;
    offset?: number;
  }): Promise<Run[]>;
}

export interface StageStore {
  create(stage: Stage): Promise<void>;
  update(stage: Stage): Promise<void>;
  updateStatus(
    stageId: string,
    status: Stage["status"],
    timestamps?: { startedAt?: string; finishedAt?: string },
  ): Promise<void>;
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

export interface RunRequestRecord {
  requestId: string;
  runId: string;
  workspaceId: string;
  workflowId: string;
  payload: string;
  status: "queued" | "claimed" | "done" | "failed";
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRequestStore {
  enqueue(
    record: Pick<
      RunRequestRecord,
      | "requestId"
      | "runId"
      | "workspaceId"
      | "workflowId"
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
  heartbeat(requestId: string, owner: string, now: Date): Promise<void>;
  finish(
    requestId: string,
    status: "done" | "failed",
    error?: string,
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
  constructor(private readonly db: Database) {}

  async create(run: Run): Promise<void> {
    await this.db.insert(runs).values(toRunRow(run)).onConflictDoNothing();
  }

  async updateStatus(
    runId: string,
    status: Run["status"],
    updatedAt: string,
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({ status, updatedAt })
      .where(eq(runs.runId, runId));
  }

  async get(runId: string): Promise<Run | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);

    return row ? fromRunRow(row) : null;
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
  constructor(private readonly db: Database) {}

  async create(stage: Stage): Promise<void> {
    await this.db
      .insert(stages)
      .values(toStageRow(stage))
      .onConflictDoNothing();
  }

  async update(stage: Stage): Promise<void> {
    await this.db
      .update(stages)
      .set(toStageRow(stage))
      .where(eq(stages.stageId, stage.stageId));
  }

  async updateStatus(
    stageId: string,
    status: Stage["status"],
    timestamps: { startedAt?: string; finishedAt?: string } = {},
  ): Promise<void> {
    await this.db
      .update(stages)
      .set({
        status,
        ...(timestamps.startedAt ? { startedAt: timestamps.startedAt } : {}),
        ...(timestamps.finishedAt ? { finishedAt: timestamps.finishedAt } : {}),
      })
      .where(eq(stages.stageId, stageId));
  }

  async listByRun(runId: string): Promise<Stage[]> {
    const rows = await this.db
      .select()
      .from(stages)
      .where(eq(stages.runId, runId));

    return rows.map(fromStageRow);
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
    await this.db.transaction(async (tx) => {
      await tx.insert(manifests).values(toManifestRow(manifest));
      await tx.insert(artifacts).values(toArtifactRow(artifact));
    });
  }

  async putVersion(artifact: ArtifactVersion): Promise<void> {
    await this.db
      .insert(artifacts)
      .values(toArtifactRow(artifact))
      .onConflictDoNothing();
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
    payload: row.payload,
    status: row.status as RunRequestRecord["status"],
    claimedBy: row.claimedBy ?? null,
    claimedAt: row.claimedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresRunRequestStore implements RunRequestStore {
  constructor(private readonly db: Database) {}

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
        payload: record.payload,
        status: "queued",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
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

  async heartbeat(requestId: string, owner: string, now: Date): Promise<void> {
    const nowIso = now.toISOString();
    await this.db
      .update(runRequests)
      .set({ heartbeatAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(runRequests.requestId, requestId),
          eq(runRequests.claimedBy, owner),
        ),
      );
  }

  async finish(
    requestId: string,
    status: "done" | "failed",
    error?: string,
  ): Promise<void> {
    await this.db
      .update(runRequests)
      .set({
        status,
        error: error ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(runRequests.requestId, requestId));
  }

  async find(runId: string): Promise<RunRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.runId, runId))
      .limit(1);
    return row ? fromRunRequestRow(row) : null;
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
