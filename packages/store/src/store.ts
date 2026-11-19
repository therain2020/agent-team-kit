import { ApprovalService } from "./approval-service";
import { ArtifactService } from "./artifact-service";
import { type BlobClient, FsBlobClient, S3BlobClient } from "./blob";
import { BudgetService } from "./budget-service";
import { type StoreConfig, loadStoreConfig } from "./config";
import { createDb } from "./db";
import { ensureSchema } from "./migrate";
import {
  PostgresArtifactStore,
  PostgresAutopilotStateStore,
  PostgresBlobRepository,
  PostgresDegradationStore,
  PostgresEventStore,
  PostgresKillSwitchStore,
  PostgresManagerSessionStore,
  PostgresManifestStore,
  PostgresRunRequestStore,
  PostgresRunStore,
  PostgresStageStore,
} from "./repositories";
import {
  SqliteArtifactStore,
  SqliteAutopilotStateStore,
  SqliteBlobRepository,
  SqliteDegradationStore,
  SqliteEventStore,
  SqliteKillSwitchStore,
  SqliteManagerSessionStore,
  SqliteManifestStore,
  SqliteRunRequestStore,
  SqliteRunStore,
  SqliteStageStore,
} from "./repositories.sqlite";
import { createS3Client } from "./s3";

export function createStore(config: StoreConfig = loadStoreConfig()) {
  const handle = createDb(config);

  const blobClient: BlobClient =
    config.blobBackend === "s3"
      ? new S3BlobClient(createS3Client(config), config.s3Bucket)
      : new FsBlobClient(config.blobRoot);

  // Fenced/CAS writes are audited to the op log; the sink only needs `sql`.
  const opLog = { sql: handle.sql };

  const repositories =
    handle.driver === "postgres"
      ? {
          events: new PostgresEventStore(handle.db),
          runs: new PostgresRunStore(handle.db, opLog),
          stages: new PostgresStageStore(handle.db, opLog),
          manifests: new PostgresManifestStore(handle.db),
          blobs: new PostgresBlobRepository(handle.db),
          artifactStore: new PostgresArtifactStore(handle.db),
          autopilotState: new PostgresAutopilotStateStore(handle.db),
          runRequests: new PostgresRunRequestStore(handle.db, opLog),
          degradation: new PostgresDegradationStore(handle.db),
          managerSessions: new PostgresManagerSessionStore(handle.db),
          killSwitches: new PostgresKillSwitchStore(handle.db),
        }
      : {
          events: new SqliteEventStore(handle.db),
          runs: new SqliteRunStore(handle.db, opLog),
          stages: new SqliteStageStore(handle.db, opLog),
          manifests: new SqliteManifestStore(handle.db),
          blobs: new SqliteBlobRepository(handle.db),
          artifactStore: new SqliteArtifactStore(handle.db),
          autopilotState: new SqliteAutopilotStateStore(handle.db),
          runRequests: new SqliteRunRequestStore(handle.db, opLog),
          degradation: new SqliteDegradationStore(handle.db),
          managerSessions: new SqliteManagerSessionStore(handle.db),
          killSwitches: new SqliteKillSwitchStore(handle.db),
        };

  const { blobs, artifactStore } = repositories;

  return {
    config,
    driver: handle.driver,
    sql: handle.sql,
    exec: handle.exec,
    close: handle.close,
    ping: handle.ping,
    ...repositories,
    blobClient,
    artifactService: new ArtifactService(blobs, artifactStore, blobClient, {
      sql: handle.sql,
    }),
    approvals: new ApprovalService({
      sql: handle.sql,
      driver: handle.driver,
    }),
    budgetService: new BudgetService({
      sql: handle.sql,
      driver: handle.driver,
    }),
  };
}

export async function initStore(config: StoreConfig = loadStoreConfig()) {
  const store = createStore(config);
  await ensureSchema(store.exec, store.driver);
  await store.blobClient.ensure();
  return store;
}
