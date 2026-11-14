import { closeEngineStore, startLocalRunner } from "@kit/engine";
import { initStore, loadStoreConfig } from "@kit/store";

const store = await initStore(loadStoreConfig());

if (store.driver !== "sqlite") {
  console.error(
    "✖ local runner requires KIT_RUNTIME_MODE=local (embedded SQLite store)",
  );
  await store.close();
  process.exit(1);
}

const stop = startLocalRunner({ store });
console.log(
  `[local-runner] ready pid=${process.pid} db=${store.config.localDbPath}`,
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  stop();
  await closeEngineStore().catch(() => undefined);
  await store.close().catch(() => undefined);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
