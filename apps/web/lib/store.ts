import path from "node:path";
import { createStore, ensureSchema, loadStoreConfig } from "@kit/store";

type Store = ReturnType<typeof createStore>;

const globalForStore = globalThis as typeof globalThis & {
  __kitWebStore?: Store;
  __kitWebSchema?: Promise<void>;
};

function resolveBlobRoot(): string {
  if (process.env.KIT_BLOB_ROOT) {
    return process.env.KIT_BLOB_ROOT;
  }

  const cwd = process.cwd();
  const isWebApp =
    path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps";
  const repoRoot = isWebApp ? path.resolve(cwd, "../..") : cwd;
  return path.join(repoRoot, ".tmp", "blobs");
}

export function getStore(): Store {
  globalForStore.__kitWebStore ??= createStore(
    loadStoreConfig({
      ...process.env,
      KIT_BLOB_ROOT: resolveBlobRoot(),
    }),
  );
  return globalForStore.__kitWebStore;
}

export async function ensureStoreSchema(): Promise<void> {
  const store = getStore();
  globalForStore.__kitWebSchema ??= ensureSchema(store.exec).catch((error) => {
    globalForStore.__kitWebSchema = undefined;
    throw error;
  });
  await globalForStore.__kitWebSchema;
}
