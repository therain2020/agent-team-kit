import { createHash } from "node:crypto";
import {
  type ArtifactVersion,
  type Blob,
  type Manifest,
  type Producer,
  type RunMode,
  type Sensitivity,
  newId,
} from "@kit/core";
import type { BlobClient } from "./blob";
import type {
  PostgresArtifactStore,
  PostgresBlobRepository,
} from "./repositories";

export interface PublishInput {
  workspaceId: string;
  content: Uint8Array;
  producer: Producer;
  inputs: { artifactId: string; version: number }[];
  runId: string;
  stageId: string;
  runMode: RunMode;
  cost: { currency: "CNY"; amount: number; tokens: number };
  sensitivity: Sensitivity;
  retentionClass: string;
}

export interface PublishResult {
  artifact: ArtifactVersion;
  manifest: Manifest;
  blob: Blob;
  deduped: boolean;
}

export class ArtifactService {
  constructor(
    private readonly blobs: PostgresBlobRepository,
    private readonly artifacts: PostgresArtifactStore,
    private readonly blobClient: BlobClient,
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const storageKey = `blobs/${input.workspaceId}/${sha256}`;

    await this.blobClient.put(storageKey, input.content);

    let blob = await this.blobs.find(input.workspaceId, sha256);
    let deduped = blob !== null;

    if (!blob) {
      const candidate: Blob = {
        blobId: newId("blb"),
        workspaceId: input.workspaceId,
        sha256,
        size: input.content.byteLength,
        storageKey,
        createdAt: new Date().toISOString(),
      };

      const inserted = await this.blobs.insert(candidate);
      if (inserted) {
        blob = candidate;
      } else {
        blob = await this.blobs.find(input.workspaceId, sha256);
        deduped = true;
      }

      if (!blob) {
        throw new Error("blob insert race: row not found");
      }
    }

    const now = new Date().toISOString();
    const manifest: Manifest = {
      manifestId: newId("man"),
      workspaceId: input.workspaceId,
      producer: input.producer,
      inputs: input.inputs,
      runId: input.runId,
      stageId: input.stageId,
      runMode: input.runMode,
      cost: input.cost,
      evalRefs: [],
      approvalRefs: [],
      sensitivity: input.sensitivity,
      retentionClass: input.retentionClass,
      createdAt: now,
    };

    const artifact: ArtifactVersion = {
      artifactId: newId("art"),
      version: 1,
      workspaceId: input.workspaceId,
      blobId: blob.blobId,
      manifestId: manifest.manifestId,
      status: "committed",
      supersedes: null,
      supersededBy: null,
      createdAt: now,
    };

    await this.artifacts.createCommitted(manifest, artifact);

    return { artifact, manifest, blob, deduped };
  }
}
