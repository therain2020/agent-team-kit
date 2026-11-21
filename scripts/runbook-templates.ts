/**
 * Default runbook templates per degradation mode (61 §3.2, §5).
 *
 * Extracted from `runbook-drill.ts` so every drill that has to guarantee an
 * active runbook (runbook coverage, degradation drills) seeds the same steps
 * instead of inventing its own copy.
 */
export interface RunbookTemplate {
  trigger: string;
  steps: { order: number; action: string; expected: string }[];
  verification: { check: string; expected: string }[];
}

export const RUNBOOK_TEMPLATES: Record<string, RunbookTemplate> = {
  "model.provider": {
    trigger: "model provider outage or circuit open",
    steps: [
      {
        order: 1,
        action: "Enable an allowed fallback model or pause the affected stage",
        expected: "stage paused or serving a permitted fallback",
      },
      {
        order: 2,
        action: "Re-check the quality floor before any external output",
        expected: "quality floor passes",
      },
      {
        order: 3,
        action: "Serve the verified LKG for external delivery",
        expected: "delivery uses verified LKG",
      },
    ],
    verification: [
      { check: "quality floor", expected: "all external outputs pass" },
    ],
  },
  event_bus: {
    trigger: "event bus unavailable",
    steps: [
      {
        order: 1,
        action: "Enable the local persistent spool buffer",
        expected: "buffer-only mode active",
      },
      {
        order: 2,
        action: "Stop accepting unbounded new tasks",
        expected: "backlog bounded",
      },
      {
        order: 3,
        action: "On recovery replay by event_id and dedupe",
        expected: "spool drained with no duplicates",
      },
    ],
    verification: [
      { check: "event_spool pending", expected: "0 after recovery" },
    ],
  },
  artifact_store: {
    trigger: "artifact store unavailable",
    steps: [
      {
        order: 1,
        action: "Stop publishing and suspend the run",
        expected: "runs suspended",
      },
      {
        order: 2,
        action: "Stage outputs locally and checksum them",
        expected: "staged files checksummed",
      },
      {
        order: 3,
        action: "On recovery re-write the Manifest",
        expected: "Manifests re-written",
      },
    ],
    verification: [
      { check: "artifact integrity", expected: "hashes match Manifest" },
    ],
  },
  source_api: {
    trigger: "source ingestion interrupted",
    steps: [
      {
        order: 1,
        action: "Pause ingestion and keep the queue",
        expected: "queue retained",
      },
      {
        order: 2,
        action: "Switch to a registered backup source",
        expected: "backup source serving",
      },
      {
        order: 3,
        action: "Annotate the coverage gap in the report",
        expected: "gap documented",
      },
    ],
    verification: [
      { check: "coverage gap", expected: "reported, no silent gap" },
    ],
  },
  delivery: {
    trigger: "quality floor not met on delivery",
    steps: [
      {
        order: 1,
        action: "Block external delivery",
        expected: "no external output",
      },
      {
        order: 2,
        action: "Serve verified LKG if available",
        expected: "LKG served or delivery stays blocked",
      },
      {
        order: 3,
        action: "Recheck quality before resuming delivery",
        expected: "quality recheck passes",
      },
    ],
    verification: [
      { check: "external delivery", expected: "100% quality-floor checked" },
    ],
  },
};
