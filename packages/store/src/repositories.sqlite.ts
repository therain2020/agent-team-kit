import type {
  ArtifactVersion,
  Blob,
  DegradationScope,
  EventEnvelope,
  Incident,
  KillSwitch,
  Manifest,
  RecoveryDrill,
  Run,
  RunStatus,
  Runbook,
  RunbookDrill,
  Stage,
} from "@kit/core";
import { switchLastKnownGood } from "@kit/core";
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
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { OpLogStore } from "./op-log";
import {
  ARTIFACT_KIND,
  applyManagerSessionRejection,
  applyManagerSessionUsage,
  artifactVersionKey,
  buildArtifactEdgeRows,
  chunkArtifactEdgeRows,
  collectArtifactAncestry,
  fromArtifactRow,
  fromBlobRow,
  fromDegradationAuditRow,
  fromDegradationRow,
  fromEventRow,
  fromIncidentRow,
  fromKillSwitchRow,
  fromLastKnownGoodRow,
  fromManifestRow,
  fromRecoveryDrillRow,
  fromRunRow,
  fromRunbookDrillRow,
  fromRunbookRow,
  fromStageRow,
  fromTriggerRunRow,
  toArtifactRow,
  toBlobRow,
  toDegradationAuditRow,
  toDegradationRow,
  toEventRow,
  toIncidentRow,
  toKillSwitchRow,
  toLastKnownGoodRow,
  toManifestRow,
  toRecoveryDrillRow,
  toRunRow,
  toRunbookDrillRow,
  toRunbookRow,
  toStageRow,
} from "./repositories";
import type {
  ArtifactAncestryNode,
  ArtifactEdgeBackfillResult,
  ArtifactEdgeLink,
  ArtifactEdgeRelation,
  ArtifactEdgeRow,
  ArtifactStore,
  ArtifactVersionRef,
  AutopilotStateRecord,
  AutopilotStateStore,
  BlobRepository,
  DegradationAuditRecord,
  DegradationStateRecord,
  DegradationStore,
  DrillStore,
  EventStore,
  IncidentListOptions,
  IncidentStore,
  KillSwitchActivation,
  KillSwitchStore,
  LastKnownGoodStore,
  LastKnownGoodSwitch,
  ManagerSessionRecord,
  ManagerSessionRejectionInput,
  ManagerSessionStore,
  ManagerSessionUsageInput,
  ManifestStore,
  RunRequestRecord,
  RunRequestStore,
  RunStore,
  RunbookListOptions,
  RunbookStore,
  StageStore,
  TriggerRunListOptions,
  TriggerRunRecord,
  TriggerRunStore,
} from "./repositories";
import type * as sqliteSchema from "./schema.sqlite";
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
  triggerRuns,
} from "./schema.sqlite";
import {
  VersionConflictError,
  type WriteConflictDetail,
  type WriteLease,
  type WriteOptions,
  conflictDetail,
  leaseClaimExists,
  recordWriteConflict,
} from "./write-fencing";

export type SqliteDatabase = BetterSQLite3Database<typeof sqliteSchema>;

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: SqliteDatabase) {}

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

export class SqliteRunStore implements RunStore {
  constructor(
    private readonly db: SqliteDatabase,
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

  async get(runId: string) {
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

  async listRecent(limit = 20) {
    return this.list({ limit });
  }

  async list(
    options: { status?: RunStatus; limit?: number; offset?: number } = {},
  ) {
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

export class SqliteStageStore implements StageStore {
  constructor(
    private readonly db: SqliteDatabase,
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

  async listByRun(runId: string) {
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

export class SqliteManifestStore implements ManifestStore {
  constructor(private readonly db: SqliteDatabase) {}

  async put(manifest: Manifest): Promise<void> {
    await this.db.insert(manifests).values(toManifestRow(manifest));
  }

  async get(manifestId: string) {
    const [row] = await this.db
      .select()
      .from(manifests)
      .where(eq(manifests.manifestId, manifestId))
      .limit(1);
    return row ? fromManifestRow(row) : null;
  }
}

export class SqliteBlobRepository implements BlobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findById(blobId: string) {
    const [row] = await this.db
      .select()
      .from(blobs)
      .where(eq(blobs.blobId, blobId))
      .limit(1);
    return row ? fromBlobRow(row) : null;
  }

  async find(workspaceId: string, sha256: string) {
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

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: SqliteDatabase) {}

  async createCommitted(
    manifest: Manifest,
    artifact: ArtifactVersion,
  ): Promise<void> {
    const { rows } = buildArtifactEdgeRows(artifact, manifest.inputs);
    this.db.transaction((tx) => {
      tx.insert(manifests).values(toManifestRow(manifest)).run();
      tx.insert(artifacts).values(toArtifactRow(artifact)).run();
      if (rows.length > 0) {
        tx.insert(artifactEdges).values(rows).onConflictDoNothing().run();
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
    this.db.transaction((tx) => {
      tx.insert(artifacts)
        .values(toArtifactRow(artifact))
        .onConflictDoNothing()
        .run();
      if (rows.length > 0) {
        tx.insert(artifactEdges).values(rows).onConflictDoNothing().run();
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

  async findById(artifactId: string, version = 1) {
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

  async findCommittedByRunStage(runId: string, stageId: string) {
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

  async listByRun(runId: string) {
    const rows = await this.db
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(manifests, eq(artifacts.manifestId, manifests.manifestId))
      .where(
        and(eq(manifests.runId, runId), eq(artifacts.status, "committed")),
      );
    return rows.map((row) => fromArtifactRow(row.artifact));
  }

  async listRecent(workspaceId: string, limit = 10) {
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
    for (const chunk of chunkArtifactEdgeRows(rows, 200)) {
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

export class SqliteAutopilotStateStore implements AutopilotStateStore {
  constructor(private readonly db: SqliteDatabase) {}

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
    return row ? fromSqliteAutopilotRow(row) : null;
  }

  async list(workspaceId: string): Promise<AutopilotStateRecord[]> {
    const rows = await this.db
      .select()
      .from(autopilotState)
      .where(eq(autopilotState.workspaceId, workspaceId))
      .orderBy(asc(autopilotState.packDir));
    return rows.map(fromSqliteAutopilotRow);
  }

  async insertIfMissing(record: AutopilotStateRecord): Promise<void> {
    await this.db
      .insert(autopilotState)
      .values(toSqliteAutopilotRow(record))
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
        spentToday: record.spentToday,
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

export class SqliteTriggerRunStore implements TriggerRunStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(record: TriggerRunRecord): Promise<boolean> {
    const rows = await this.db
      .insert(triggerRuns)
      .values({
        triggerRunId: record.triggerRunId,
        workspaceId: record.workspaceId,
        triggerId: record.triggerId,
        triggerKind: record.kind,
        routeId: record.routeId,
        jobKind: record.jobKind,
        dedupeKey: record.dedupeKey,
        jobId: record.jobId,
        status: record.status,
        launchedAt: record.launchedAt,
        estimateCny: record.estimateCny,
        payloadRef: record.payloadRef,
        lastError: record.lastError,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoNothing()
      .returning({ triggerRunId: triggerRuns.triggerRunId });
    return rows.length > 0;
  }

  async get(triggerRunId: string): Promise<TriggerRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(triggerRuns)
      .where(eq(triggerRuns.triggerRunId, triggerRunId))
      .limit(1);
    return row ? fromTriggerRunRow(row) : null;
  }

  async findByDedupeKey(
    triggerId: string,
    dedupeKey: string,
  ): Promise<TriggerRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(triggerRuns)
      .where(
        and(
          eq(triggerRuns.triggerId, triggerId),
          eq(triggerRuns.dedupeKey, dedupeKey),
        ),
      )
      .limit(1);
    return row ? fromTriggerRunRow(row) : null;
  }

  async list(
    workspaceId: string,
    options: TriggerRunListOptions = {},
  ): Promise<TriggerRunRecord[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 5000));
    const conditions: SQL[] = [eq(triggerRuns.workspaceId, workspaceId)];
    if (options.triggerId) {
      conditions.push(eq(triggerRuns.triggerId, options.triggerId));
    }
    if (options.status) {
      conditions.push(eq(triggerRuns.status, options.status));
    }
    if (options.since) {
      conditions.push(sql`${triggerRuns.launchedAt} >= ${options.since}`);
    }
    const rows = await this.db
      .select()
      .from(triggerRuns)
      .where(and(...conditions))
      .orderBy(desc(triggerRuns.launchedAt))
      .limit(limit);
    return rows.map(fromTriggerRunRow);
  }

  async finish(
    triggerRunId: string,
    jobId: string | null,
    status: string,
    estimateCny: number,
    lastError: string | null,
    updatedAt: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(triggerRuns)
      .set({ jobId, status, estimateCny, lastError, updatedAt })
      .where(eq(triggerRuns.triggerRunId, triggerRunId))
      .returning({ triggerRunId: triggerRuns.triggerRunId });
    return rows.length > 0;
  }
}

export class SqliteManagerSessionStore implements ManagerSessionStore {
  constructor(private readonly db: SqliteDatabase) {}

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
    return row ? fromSqliteManagerSessionRow(row) : null;
  }

  async addUsage(
    input: ManagerSessionUsageInput,
  ): Promise<ManagerSessionRecord> {
    const existing = await this.get(input.workspaceId, input.sessionId);
    const record = applyManagerSessionUsage(existing, input);
    await this.db
      .insert(managerSessions)
      .values(toSqliteManagerSessionRow(record))
      .onConflictDoUpdate({
        target: [managerSessions.workspaceId, managerSessions.sessionId],
        set: sqliteManagerSessionUpdateSet(record),
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
      .values(toSqliteManagerSessionRow(record))
      .onConflictDoUpdate({
        target: [managerSessions.workspaceId, managerSessions.sessionId],
        set: sqliteManagerSessionUpdateSet(record),
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

export class SqliteRunRequestStore implements RunRequestStore {
  constructor(
    private readonly db: SqliteDatabase,
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
        return fromSqliteRunRequestRow(row);
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
        await this.rejectLease(requestId, owner, expectedLeaseVersion);
      }
      return null;
    }
    return fromSqliteRunRequestRow(row);
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
      await this.rejectLease(requestId, lease.owner, lease.leaseVersion);
    }
  }

  async find(runId: string): Promise<RunRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(runRequests)
      .where(eq(runRequests.runId, runId))
      .limit(1);
    return row ? fromSqliteRunRequestRow(row) : null;
  }

  private async rejectLease(
    requestId: string,
    owner: string,
    leaseVersion: number,
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
      reason: "lease_mismatch",
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

function fromSqliteRunRequestRow(
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

function toSqliteAutopilotRow(record: AutopilotStateRecord) {
  return {
    workspaceId: record.workspaceId,
    packDir: record.packDir,
    enabled: record.enabled,
    lastTickAt: record.lastTickAt,
    nextRuns: record.nextRuns,
    day: record.day,
    runsToday: record.runsToday,
    spentToday: record.spentToday,
    lastError: record.lastError,
    updatedAt: record.updatedAt,
    version: record.version ?? 0,
  };
}

function fromSqliteAutopilotRow(
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

export class SqliteLastKnownGoodStore implements LastKnownGoodStore {
  constructor(private readonly db: SqliteDatabase) {}

  async get(lkgId: string) {
    const [row] = await this.db
      .select()
      .from(lastKnownGood)
      .where(eq(lastKnownGood.lkgId, lkgId))
      .limit(1);
    return row ? fromLastKnownGoodRow(row) : null;
  }

  async listActive(workspaceId?: string) {
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

  async history(workspaceId: string, targetKey: string, limit = 50) {
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

  async switch(record: LastKnownGoodSwitch["record"]) {
    // better-sqlite3 transactions are synchronous: use the sync builders so
    // the supersede + insert pair commits atomically.
    return this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(lastKnownGood)
        .where(eq(lastKnownGood.lkgId, record.lkgId))
        .limit(1)
        .get();
      if (existingRow) {
        return {
          record: fromLastKnownGoodRow(existingRow),
          previous: [],
          changed: false,
        };
      }

      const activeRows = tx
        .select()
        .from(lastKnownGood)
        .where(
          and(
            eq(lastKnownGood.workspaceId, record.workspaceId),
            eq(lastKnownGood.targetKey, record.targetKey),
            eq(lastKnownGood.status, "active"),
          ),
        )
        .all();
      const transition = switchLastKnownGood({
        previous: activeRows.map(fromLastKnownGoodRow),
        next: record,
      });
      for (const previous of transition.previous) {
        tx.update(lastKnownGood)
          .set({
            status: "superseded",
            supersededBy: transition.next.lkgId,
          })
          .where(eq(lastKnownGood.lkgId, previous.lkgId))
          .run();
      }
      const insertedRow = tx
        .insert(lastKnownGood)
        .values(toLastKnownGoodRow(transition.next))
        .returning()
        .get();
      if (!insertedRow) {
        throw new Error("failed to insert last-known-good");
      }
      return {
        record: fromLastKnownGoodRow(insertedRow),
        previous: transition.previous,
        changed: true,
      };
    });
  }
}

export class SqliteDegradationStore implements DegradationStore {
  constructor(private readonly db: SqliteDatabase) {}

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

function toSqliteManagerSessionRow(record: ManagerSessionRecord) {
  return {
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    windowStartedAt: record.windowStartedAt,
    windowEndsAt: record.windowEndsAt,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
    tokens: record.tokens,
    costCny: record.costCny,
    exchanges: record.exchanges,
    rejections: record.rejections,
    lastRejectionReason: record.lastRejectionReason,
    updatedAt: record.updatedAt,
  };
}

function fromSqliteManagerSessionRow(
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

function sqliteManagerSessionUpdateSet(record: ManagerSessionRecord) {
  return {
    windowStartedAt: record.windowStartedAt,
    windowEndsAt: record.windowEndsAt,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
    tokens: record.tokens,
    costCny: record.costCny,
    exchanges: record.exchanges,
    rejections: record.rejections,
    lastRejectionReason: record.lastRejectionReason,
    updatedAt: record.updatedAt,
  };
}

export class SqliteKillSwitchStore implements KillSwitchStore {
  constructor(private readonly db: SqliteDatabase) {}

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

export class SqliteIncidentStore implements IncidentStore {
  constructor(private readonly db: SqliteDatabase) {}

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

export class SqliteRunbookStore implements RunbookStore {
  constructor(private readonly db: SqliteDatabase) {}

  async upsert(runbook: Runbook): Promise<void> {
    const values = toRunbookRow(runbook);
    await this.db
      .insert(runbooks)
      .values(values)
      .onConflictDoUpdate({ target: [runbooks.runbookId], set: values });
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

export class SqliteDrillStore implements DrillStore {
  constructor(private readonly db: SqliteDatabase) {}

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
