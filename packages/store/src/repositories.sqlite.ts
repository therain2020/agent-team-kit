import type {
  ArtifactVersion,
  Blob,
  EventEnvelope,
  Manifest,
  Run,
  RunStatus,
  Stage,
} from "@kit/core";
import { and, asc, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  fromArtifactRow,
  fromBlobRow,
  fromEventRow,
  fromManifestRow,
  fromRunRow,
  fromStageRow,
  toArtifactRow,
  toBlobRow,
  toEventRow,
  toManifestRow,
  toRunRow,
  toStageRow,
} from "./repositories";
import type {
  ArtifactStore,
  AutopilotStateRecord,
  AutopilotStateStore,
  BlobRepository,
  EventStore,
  ManifestStore,
  RunStore,
  StageStore,
} from "./repositories";
import type * as sqliteSchema from "./schema.sqlite";
import {
  events,
  artifacts,
  autopilotState,
  blobs,
  manifests,
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

  async update(record: AutopilotStateRecord): Promise<void> {
    await this.db
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
      })
      .where(
        and(
          eq(autopilotState.workspaceId, record.workspaceId),
          eq(autopilotState.packDir, record.packDir),
        ),
      );
  }
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
  };
}
