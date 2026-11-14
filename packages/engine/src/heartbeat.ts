type HeartbeatHook = () => void;

let hook: HeartbeatHook = () => {};

export function setActivityHeartbeat(next: HeartbeatHook): void {
  hook = next;
}

export function heartbeat(): void {
  try {
    hook();
  } catch {
    // No engine attached (CLI/local runner); heartbeats are optional there.
  }
}
