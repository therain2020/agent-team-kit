import { ArtifactService } from "./artifact-service";
import { type BlobClient, FsBlobClient, S3BlobClient } from "./blob";
import { type StoreConfig, loadStoreConfig } from "./config";
import { createDb } from "./db";
import { ensureSchema } from "./migrate";
import {
  PostgresArtifactStore,
  PostgresAutopilotStateStore,
  PostgresBlobRepository,
  PostgresEventStore,
  PostgresManifestStore,
  PostgresRunRequestStore,
  PostgresRunStore,
  PostgresStageStore,
} from "./repositories";
import {
  SqliteArtifactStore,
  SqliteAutopilotStateStore,
  SqliteBlobRepository,
  SqliteEventStore,
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

  const repositories =
    handle.driver === "postgres"
      ? {
          events: new PostgresEventStore(handle.db),
          runs: new PostgresRunStore(handle.db),
          stages: new PostgresStageStore(handle.db),
          manifests: new PostgresManifestStore(handle.db),
          blobs: new PostgresBlobRepository(handle.db),
          artifactStore: new PostgresArtifactStore(handle.db),
          autopilotState: new PostgresAutopilotStateStore(handle.db),
          runRequests: new PostgresRunRequestStore(handle.db),
        }
      : {
          events: new SqliteEventStore(handle.db),
          runs: new SqliteRunStore(handle.db),
          stages: new SqliteStageStore(handle.db),
          manifests: new SqliteManifestStore(handle.db),
          blobs: new SqliteBlobRepository(handle.db),
          artifactStore: new SqliteArtifactStore(handle.db),
          autopilotState: new SqliteAutopilotStateStore(handle.db),
          runRequests: new SqliteRunRequestStore(handle.db),
        };

  const { blobs, artifactStore } = repositories;

  return {
    config,
    driver: handle.driver,
    exec: handle.exec,
    close: handle.close,
    ping: handle.ping,
    ...repositories,
    blobClient,
    artifactService: new ArtifactService(blobs, artifactStore, blobClient),
  };
}

export async function initStore(config: StoreConfig = loadStoreConfig()) {
  const store = createStore(config);
  await ensureSchema(store.exec, store.driver);
  await store.blobClient.ensure();
  return store;
}
