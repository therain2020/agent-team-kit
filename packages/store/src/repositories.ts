import type {
  ArtifactVersion,
  Blob,
  EventEnvelope,
  Manifest,
  Run,
  RunMode,
  RunStatus,
  Sensitivity,
  Stage,
  StageStatus,
} from "@kit/core";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "./db";
import { events, artifacts, blobs, manifests, runs, stages } from "./schema";

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

function toEventRow(event: EventEnvelope) {
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

function fromEventRow(row: typeof events.$inferSelect): EventEnvelope {
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

function toRunRow(run: Run) {
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

function fromRunRow(row: typeof runs.$inferSelect): Run {
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

function toStageRow(stage: Stage) {
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

function fromStageRow(row: typeof stages.$inferSelect): Stage {
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

function toManifestRow(manifest: Manifest) {
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

function fromManifestRow(row: typeof manifests.$inferSelect): Manifest {
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

function toBlobRow(blob: Blob) {
  return {
    blobId: blob.blobId,
    workspaceId: blob.workspaceId,
    sha256: blob.sha256,
    size: blob.size,
    storageKey: blob.storageKey,
    createdAt: blob.createdAt,
  };
}

function fromBlobRow(row: typeof blobs.$inferSelect): Blob {
  return {
    blobId: row.blobId,
    workspaceId: row.workspaceId,
    sha256: row.sha256,
    size: Number(row.size),
    storageKey: row.storageKey,
    createdAt: row.createdAt,
  };
}

function toArtifactRow(artifact: ArtifactVersion) {
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

function fromArtifactRow(row: typeof artifacts.$inferSelect): ArtifactVersion {
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

export class PostgresBlobRepository {
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

export class PostgresArtifactStore {
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
