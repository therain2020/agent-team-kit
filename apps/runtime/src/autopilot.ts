import { startAutopilotDaemon } from "@kit/autopilot";

const stop = await startAutopilotDaemon({
  repoRoot: process.cwd(),
  intervalMs: Number(process.env.KIT_AUTOPILOT_INTERVAL_MS ?? 30_000),
});

console.log("[autopilot] daemon started");

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  stop();
  console.log("[autopilot] daemon stopped");
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
