import { ArtifactService } from "./artifact-service";
import { type BlobClient, FsBlobClient, S3BlobClient } from "./blob";
import { type StoreConfig, loadStoreConfig } from "./config";
import { createDb } from "./db";
import { ensureSchema } from "./migrate";
import {
  PostgresArtifactStore,
  PostgresBlobRepository,
  PostgresEventStore,
  PostgresManifestStore,
  PostgresRunStore,
  PostgresStageStore,
} from "./repositories";
import { createS3Client } from "./s3";

export function createStore(config: StoreConfig = loadStoreConfig()) {
  const { sql, db } = createDb(config.dbUrl);

  const blobClient: BlobClient =
    config.blobBackend === "s3"
      ? new S3BlobClient(createS3Client(config), config.s3Bucket)
      : new FsBlobClient(config.blobRoot);

  const blobs = new PostgresBlobRepository(db);
  const artifactStore = new PostgresArtifactStore(db);

  return {
    config,
    sql,
    db,
    events: new PostgresEventStore(db),
    runs: new PostgresRunStore(db),
    stages: new PostgresStageStore(db),
    manifests: new PostgresManifestStore(db),
    blobs,
    artifactStore,
    blobClient,
    artifactService: new ArtifactService(blobs, artifactStore, blobClient),
  };
}

export async function initStore(config: StoreConfig = loadStoreConfig()) {
  const store = createStore(config);
  await ensureSchema(store.sql);
  await store.blobClient.ensure();
  return store;
}
