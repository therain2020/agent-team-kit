import type {
  ArtifactVersion,
  Blob,
  DegradationScope,
  EventEnvelope,
  KillSwitch,
  Manifest,
  Run,
  RunStatus,
  Stage,
} from "@kit/core";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  applyManagerSessionRejection,
  applyManagerSessionUsage,
  fromArtifactRow,
  fromBlobRow,
  fromDegradationAuditRow,
  fromDegradationRow,
  fromEventRow,
  fromKillSwitchRow,
  fromManifestRow,
  fromRunRow,
  fromStageRow,
  toArtifactRow,
  toBlobRow,
  toDegradationAuditRow,
  toDegradationRow,
  toEventRow,
  toKillSwitchRow,
  toManifestRow,
  toRunRow,
  toStageRow,
} from "./repositories";
import type {
  ArtifactStore,
  AutopilotStateRecord,
  AutopilotStateStore,
  BlobRepository,
  DegradationAuditRecord,
  DegradationStateRecord,
  DegradationStore,
  EventStore,
  ManagerSessionRecord,
  ManagerSessionRejectionInput,
  ManagerSessionStore,
  ManagerSessionUsageInput,
  KillSwitchActivation,
  KillSwitchStore,
  ManifestStore,
  RunRequestRecord,
  RunRequestStore,
  RunStore,
  StageStore,
} from "./repositories";
import type * as sqliteSchema from "./schema.sqlite";
import {
  events,
  artifacts,
  autopilotState,
  blobs,
  degradationAudit,
  degradationState,
  managerSessions,
  killSwitches,
  manifests,
  runRequests,
  runs,
  stages,
} from "./schema.sqlite";

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
  constructor(private readonly db: SqliteDatabase) {}

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

  async get(runId: string) {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);
    return row ? fromRunRow(row) : null;
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
  constructor(private readonly db: SqliteDatabase) {}

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

  async listByRun(runId: string) {
    const rows = await this.db
      .select()
      .from(stages)
      .where(eq(stages.runId, runId));
    return rows.map(fromStageRow);
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
    this.db.transaction((tx) => {
      tx.insert(manifests).values(toManifestRow(manifest)).run();
      tx.insert(artifacts).values(toArtifactRow(artifact)).run();
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
  constructor(private readonly db: SqliteDatabase) {}

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
        return fromSqliteRunRequestRow(row);
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
    return row ? fromSqliteRunRequestRow(row) : null;
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
