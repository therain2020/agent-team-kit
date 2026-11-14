import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { ensureBucket, getObject, putObject } from "./s3";

export interface BlobClient {
  ensure(): Promise<void>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export class FsBlobClient implements BlobClient {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });

    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, body);

    try {
      await rename(temp, target);
    } catch (error) {
      if (await this.exists(target)) {
        await unlink(temp);
        return;
      }
      throw error;
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.resolve(key));
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    const prefix = this.root.endsWith(path.sep)
      ? this.root
      : this.root + path.sep;
    if (!target.startsWith(prefix)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    return target;
  }
}

export class S3BlobClient implements BlobClient {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async ensure(): Promise<void> {
    await ensureBucket(this.client, this.bucket);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await putObject(this.client, this.bucket, key, body);
  }

  async get(key: string): Promise<Uint8Array> {
    return getObject(this.client, this.bucket, key);
  }
}
