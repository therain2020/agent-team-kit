#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ActivityEvent, appendActivity } from "@kit/activity";
import type { ArtifactVersion, Manifest, Run } from "@kit/core";
import { initStore, loadStoreConfig, loadWorldSnapshot } from "@kit/store";
import { buildWorldDelta } from "../apps/web/lib/world";
import {
  buildWeb,
  clampInt,
  clampNumber,
  median,
  percentile,
  preserveGeneratedFiles,
  runCommand,
  startProductionServer,
  tail,
} from "./bench-harness";

/**
 * `/office` production acceptance benchmark (97 §5, 87 §4.5, issue #255).
 *
 * Measures the two plan thresholds against a real `next start` build:
 *   1. first paint — `GET /office` server response p95 ≤ 800ms;
 *   2. live state  — a state change published to the activity log reaches the
 *      world SSE stream within p95 ≤ 2s (server poll + the client's 250ms
 *      batch window are both counted).
 *
 * It also reports the live overlay cost: the initial `/api/world` snapshot
 * bytes + one delta frame must stay ≤10% of the bytes first paint ships, and
 * the live path must execute a constant, bounded number of SQL statements
 * (the world loader is defined as two SELECTs).
 *
 * Verdicts: `pass` (within plan thresholds), `warn` (over a threshold but
 * inside the regression factor) and `fail` (over threshold × factor, or any
 * hard bound). Only `gate` mode exits non-zero on `fail`, so shared-runner
 * noise cannot block every PR — see `.github/workflows/perf.yml`.
 */

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, "apps", "web");
const distDir = process.env.KIT_WEB_DIST_DIR ?? ".next-bench";
const stateDir = path.resolve(
  process.env.BENCH_STATE_DIR ??
    path.join(repoRoot, ".tmp", "office-perf", "state"),
);
const reportPath = path.resolve(
  process.env.BENCH_REPORT ??
    path.join(repoRoot, ".tmp", "office-perf", "office-perf.json"),
);
const samples = clampInt(process.env.BENCH_SAMPLES, 5, 50, 20);
const firstPaintP95Limit = clampInt(
  process.env.BENCH_OFFICE_P95_MS,
  100,
  60_000,
  800,
);
const liveP95Limit = clampInt(
  process.env.BENCH_OFFICE_LIVE_P95_MS,
  100,
  60_000,
  2_000,
);
const bytesRatioLimit = clampNumber(
  process.env.BENCH_LIVE_BYTES_RATIO,
  0.01,
  1,
  0.1,
);
const liveQueryLimit = clampInt(process.env.BENCH_LIVE_QUERY_LIMIT, 1, 50, 4);
const regressionFactor = clampNumber(
  process.env.BENCH_REGRESSION_FACTOR,
  1,
  3,
  1.25,
);
const mode = process.env.BENCH_MODE === "gate" ? "gate" : "advisory";
const seededRuns = clampInt(process.env.BENCH_SEED_RUNS, 0, 24, 12);
const seededArtifacts = clampInt(process.env.BENCH_SEED_ARTIFACTS, 0, 10, 5);
const requestTimeout = clampInt(
  process.env.BENCH_TIMEOUT_MS,
  1_000,
  120_000,
  30_000,
);
const liveTimeout = clampInt(
  process.env.BENCH_LIVE_TIMEOUT_MS,
  500,
  30_000,
  10_000,
);

/** Waterfall route pinned to one pack so the snapshot is deterministic. */
const OFFICE_PACK = "minimal";
const OFFICE_ROUTE = `/office?pack=${OFFICE_PACK}`;
const WORKFLOW_ID = "demo";
const AGENT_ID = "echo";
const WORKSPACE_ID = "default";
/** Client stream-delta batch window (world-state.ts §97.3). */
const CLIENT_BATCH_MS = 250;

const dbPath = path.join(stateDir, "kit.db");
const blobRoot = path.join(stateDir, "blobs");
const benchEnv: NodeJS.ProcessEnv = {
  ...process.env,
  KIT_WEB_DIST_DIR: distDir,
  KIT_DB_DRIVER: "sqlite",
  KIT_LOCAL_DB: dbPath,
  KIT_BLOB_ROOT: blobRoot,
  KIT_MODEL_MODE: "stub",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
};

const commitSha = await resolveCommitSha();
await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
await mkdir(stateDir, { recursive: true });

const store = await initStore(loadStoreConfig(benchEnv));
await seedOfficeData(store, seededRuns, seededArtifacts);

const generatedFiles = await preserveGeneratedFiles(webRoot);
let server: Awaited<ReturnType<typeof startProductionServer>> | undefined;

try {
  const build = await buildWeb(repoRoot, benchEnv);
  if (build.exitCode !== 0) {
    console.error("[bench-office] web build failed");
    console.error(tail(build.stdout));
    console.error(tail(build.stderr));
    throw new Error("web build failed");
  }

  // `/api/health` is 503 without Temporal/Postgres, so readiness is the world
  // snapshot endpoint: it is the store + schema path this benchmark needs.
  server = await startProductionServer({
    webRoot,
    env: benchEnv,
    healthPath: "/api/world",
  });
  const base = server.base;

  // Warm caches and let the one-time projection backfill run before timing.
  await readDocument(`${base}${OFFICE_ROUTE}`);
  const warmSnapshot = await readJson(`${base}/api/world`);

  const firstPaint = await measureFirstPaint(base);
  const liveSnapshot = await measureLiveSnapshot(base);
  const live = await measureLiveUpdates(base, store);

  const queryCost = await measureLiveQueries(store);
  const livePayloadBytes = liveSnapshot.bytes + live.deltaBytes;
  const bytesRatio = firstPaint.totalBytes
    ? livePayloadBytes / firstPaint.totalBytes
    : Number.POSITIVE_INFINITY;

  const failures: string[] = [];
  const warnings: string[] = [];
  const budget = (
    label: string,
    value: number,
    limit: number,
    unit: string,
    hard = false,
  ) => {
    if (hard) {
      if (value > limit) {
        failures.push(`${label} ${value}${unit} > ${limit}${unit}`);
      }
      return;
    }
    if (value > limit * regressionFactor) {
      failures.push(
        `${label} ${value}${unit} > ${limit}${unit}×${regressionFactor}`,
      );
    } else if (value > limit) {
      warnings.push(`${label} ${value}${unit} > ${limit}${unit}`);
    }
  };
  budget("first paint p95", firstPaint.p95, firstPaintP95Limit, "ms");
  budget("live update p95", live.deliveredP95, liveP95Limit, "ms");
  budget(
    "live payload ratio",
    Number(bytesRatio.toFixed(4)),
    bytesRatioLimit,
    "",
  );
  budget("live statements", queryCost.statements, liveQueryLimit, "", true);

  const verdict =
    failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";

  const report = {
    schemaVersion: 1,
    issue: "#255",
    plan: ["97-office-sandbox.md §5", "87-web-console-performance.md §4.5"],
    generatedAt: new Date().toISOString(),
    commitSha,
    ref: process.env.GITHUB_REF ?? null,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    mode,
    runner: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      bun:
        (process.versions as unknown as Record<string, string | undefined>)
          .bun ?? null,
    },
    scenario: {
      route: OFFICE_ROUTE,
      workspaceId: WORKSPACE_ID,
      seededRuns,
      seededArtifactsPerRun: seededArtifacts,
      samples,
      liveEvents: samples,
    },
    thresholds: {
      firstPaintP95Ms: firstPaintP95Limit,
      liveP95Ms: liveP95Limit,
      liveBytesRatio: bytesRatioLimit,
      liveStatements: liveQueryLimit,
      regressionFactor,
      clientBatchMs: CLIENT_BATCH_MS,
    },
    firstPaint: {
      documentMedianMs: firstPaint.median,
      documentP95Ms: firstPaint.p95,
      samplesMs: firstPaint.timings,
      htmlBytes: firstPaint.htmlBytes,
      assetBytes: firstPaint.assetBytes,
      assetCount: firstPaint.assetCount,
      assetFailures: firstPaint.assetFailures,
      totalBytes: firstPaint.totalBytes,
    },
    live: {
      deliveredMedianMs: live.deliveredMedian,
      deliveredP95Ms: live.deliveredP95,
      streamMedianMs: live.streamMedian,
      streamP95Ms: live.streamP95,
      samplesMs: live.timings,
      clientBatchMs: CLIENT_BATCH_MS,
      snapshotMedianMs: liveSnapshot.median,
      snapshotP95Ms: liveSnapshot.p95,
      snapshotBytes: liveSnapshot.bytes,
      deltaBytes: live.deltaBytes,
      payloadBytes: livePayloadBytes,
      snapshotStatements: queryCost.snapshotStatements,
      deltaStatements: queryCost.deltaStatements,
      statements: queryCost.statements,
    },
    bytesRatio: Number(bytesRatio.toFixed(6)),
    snapshotSeq: warmSnapshot.seq,
    verdict,
    pass: verdict === "pass",
    failures,
    warnings,
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeStepSummary(report);
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `[bench-office] first paint p95=${firstPaint.p95}ms (≤${firstPaintP95Limit}ms), ` +
      `live p95=${live.deliveredP95}ms (≤${liveP95Limit}ms), ` +
      `payload ratio=${(bytesRatio * 100).toFixed(2)}% ` +
      `(≤${(bytesRatioLimit * 100).toFixed(0)}%), ` +
      `statements=${queryCost.statements} → ${verdict}`,
  );

  if (mode === "gate" && verdict === "fail") {
    process.exitCode = 1;
  }
} finally {
  if (server) {
    await server.stop();
  }
  await generatedFiles.restore();
}

interface FirstPaintMeasurement {
  median: number;
  p95: number;
  timings: number[];
  htmlBytes: number;
  assetBytes: number;
  assetCount: number;
  assetFailures: number;
  totalBytes: number;
}

async function measureFirstPaint(base: string): Promise<FirstPaintMeasurement> {
  const timings: number[] = [];
  let html = "";
  let htmlBytes = 0;
  for (let index = 0; index <= samples; index += 1) {
    const started = performance.now();
    const response = await fetch(`${base}${OFFICE_ROUTE}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeout),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = performance.now() - started;
    if (!response.ok) {
      throw new Error(`${OFFICE_ROUTE} returned ${response.status}`);
    }
    if (index === 0) {
      continue;
    }
    timings.push(Math.round(elapsed));
    if (!html) {
      html = body.toString("utf8");
      htmlBytes = body.byteLength;
    }
  }
  const sorted = [...timings].sort((a, b) => a - b);

  // First paint also needs the referenced scripts/styles; measuring only the
  // document would understate the denominator of the live-payload ratio.
  const assets = new Set(collectAssetUrls(html));
  let assetBytes = 0;
  let assetCount = 0;
  let assetFailures = 0;
  for (const href of assets) {
    let url: URL;
    try {
      url = new URL(href, `${base}${OFFICE_ROUTE}`);
    } catch {
      assetFailures += 1;
      continue;
    }
    if (url.origin !== new URL(base).origin) {
      continue;
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (!response.ok) {
        assetFailures += 1;
        continue;
      }
      assetBytes += (await response.arrayBuffer()).byteLength;
      assetCount += 1;
    } catch {
      assetFailures += 1;
    }
  }

  return {
    median: median(timings),
    p95: percentile(sorted, 0.95),
    timings,
    htmlBytes,
    assetBytes,
    assetCount,
    assetFailures,
    totalBytes: htmlBytes + assetBytes,
  };
}

async function measureLiveSnapshot(base: string): Promise<{
  median: number;
  p95: number;
  bytes: number;
}> {
  const timings: number[] = [];
  let bytes = 0;
  for (let index = 0; index <= samples; index += 1) {
    const started = performance.now();
    const response = await fetch(`${base}/api/world`, {
      signal: AbortSignal.timeout(requestTimeout),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const elapsed = performance.now() - started;
    if (!response.ok) {
      throw new Error(`/api/world returned ${response.status}`);
    }
    if (index === 0) {
      continue;
    }
    timings.push(Math.round(elapsed));
    bytes = body.byteLength;
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    median: median(timings),
    p95: percentile(sorted, 0.95),
    bytes,
  };
}

/**
 * Publishes synthetic activity events through the same choke point real runs
 * use (`appendActivity`), then times how long the world SSE stream takes to
 * deliver the matching delta. SQLite streams poll every 1s; the plan budget
 * is 2s including the 250ms client batch window.
 */
async function measureLiveUpdates(
  base: string,
  store: Awaited<ReturnType<typeof initStore>>,
): Promise<{
  timings: number[];
  streamMedian: number;
  streamP95: number;
  deliveredMedian: number;
  deliveredP95: number;
  deltaBytes: number;
}> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/world/stream?live=1`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`/api/world/stream returned ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const waiters = new Set<{
    target: number;
    started: number;
    resolve: (value: { elapsedMs: number; bytes: number }) => void;
  }>();
  let pending = "";
  let deltaBytes = 0;
  let lastSeq = 0;

  const handleFrame = (frame: string) => {
    let event = "message";
    let data: string | undefined;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data = `${data ?? ""}${line.slice("data:".length).trim()}`;
      }
    }
    if (event !== "world" || !data) {
      return;
    }
    deltaBytes = Buffer.byteLength(data);
    let seq = 0;
    try {
      seq = Number((JSON.parse(data) as { seq?: number }).seq ?? 0);
    } catch {
      return;
    }
    lastSeq = Math.max(lastSeq, seq);
    for (const waiter of [...waiters]) {
      if (seq >= waiter.target) {
        waiters.delete(waiter);
        waiter.resolve({
          elapsedMs: performance.now() - waiter.started,
          bytes: deltaBytes,
        });
      }
    }
  };

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        pending += decoder.decode(value, { stream: true });
        let split = pending.indexOf("\n\n");
        while (split >= 0) {
          const frame = pending.slice(0, split);
          pending = pending.slice(split + 2);
          handleFrame(frame);
          split = pending.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
    }
  })();

  const push = async (
    label: string,
  ): Promise<{ elapsedMs: number; bytes: number }> => {
    const started = performance.now();
    let resolve!: (value: { elapsedMs: number; bytes: number }) => void;
    const settled = new Promise<{ elapsedMs: number; bytes: number }>(
      (next) => {
        resolve = next;
      },
    );
    const waiter = { target: Number.MAX_SAFE_INTEGER, started, resolve };
    waiters.add(waiter);
    const timeout = setTimeout(() => {
      waiters.delete(waiter);
      resolve({
        elapsedMs: Number.POSITIVE_INFINITY,
        bytes: 0,
      });
    }, liveTimeout);
    try {
      const eventId = await appendActivity(store, {
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        kind: "status",
        status: "working",
        tool: "bench-probe",
        summary: `office perf probe ${label}`,
      });
      waiter.target = eventId;
      // A poll may have raced the target assignment: honor an already-seen
      // frame instead of waiting a full poll cycle (or the timeout) for it.
      if (lastSeq >= eventId) {
        waiters.delete(waiter);
        resolve({
          elapsedMs: performance.now() - started,
          bytes: deltaBytes,
        });
      }
      return await settled;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    // Discard the first event: it warms the stream's poll/drain path.
    await push("warmup");
    const timings: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const { elapsedMs } = await push(String(index));
      if (!Number.isFinite(elapsedMs)) {
        throw new Error(
          `live update not delivered within ${liveTimeout}ms (sample ${index})`,
        );
      }
      timings.push(Math.round(elapsedMs));
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const delivered = timings.map((value) => value + CLIENT_BATCH_MS);
    const deliveredSorted = [...delivered].sort((a, b) => a - b);
    return {
      timings,
      streamMedian: percentile(sorted, 0.5),
      streamP95: percentile(sorted, 0.95),
      deliveredMedian: percentile(deliveredSorted, 0.5),
      deliveredP95: percentile(deliveredSorted, 0.95),
      deltaBytes,
    };
  } finally {
    controller.abort();
    await pump.catch(() => undefined);
  }
}

/**
 * Counts SQL statements the live path executes: the full snapshot loader and
 * one delta render for a touched run. Fragments count as calls too, so only
 * templates that start a statement are counted.
 */
async function measureLiveQueries(
  store: Awaited<ReturnType<typeof initStore>>,
): Promise<{
  snapshotStatements: number;
  deltaStatements: number;
  statements: number;
}> {
  const snapshot = await countStatements(store, (proxy) =>
    loadWorldSnapshot(
      proxy as unknown as Parameters<typeof loadWorldSnapshot>[0],
    ),
  );
  const event: ActivityEvent = {
    eventId: 1,
    workspaceId: WORKSPACE_ID,
    runId: `bench-run-${String(Math.max(0, seededRuns - 1)).padStart(2, "0")}`,
    stageId: `${WORKFLOW_ID}:echo`,
    agentId: AGENT_ID,
    kind: "status",
    status: "working",
    tool: "bench-probe",
    summary: "bench delta",
    payload: {},
    createdAt: new Date().toISOString(),
  };
  const delta = await countStatements(store, (proxy) =>
    buildWorldDelta(
      proxy as unknown as Parameters<typeof buildWorldDelta>[0],
      WORKSPACE_ID,
      [event],
    ),
  );
  return {
    snapshotStatements: snapshot.statements,
    deltaStatements: delta.statements,
    statements: snapshot.statements + delta.statements,
  };
}

async function countStatements<T>(
  store: T,
  run: (store: T) => Promise<unknown>,
): Promise<{ statements: number }> {
  let statements = 0;
  const sql = (store as unknown as { sql: (...args: unknown[]) => unknown })
    .sql;
  const counted = new Proxy(sql, {
    apply(target, thisArg, args) {
      const strings = args[0] as readonly string[] | undefined;
      if (
        Array.isArray(strings) &&
        strings.some((part) =>
          /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(part),
        )
      ) {
        statements += 1;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  const proxy = { ...(store as object), sql: counted } as unknown as T;
  await run(proxy);
  return { statements };
}

async function seedOfficeData(
  store: Awaited<ReturnType<typeof initStore>>,
  runs: number,
  artifactsPerRun: number,
): Promise<void> {
  if (runs <= 0) {
    return;
  }
  const base = Date.now() - runs * 60_000;
  for (let index = 0; index < runs; index += 1) {
    const runId = `bench-run-${String(index).padStart(2, "0")}`;
    const createdAt = new Date(base + index * 60_000).toISOString();
    const run: Run = {
      runId,
      eventId: `bench-event-${index}`,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      workflowVersion: "1.0",
      runMode: "LIVE",
      status: index === runs - 1 ? "running" : "succeeded",
      originKind: "manual",
      createdAt,
      updatedAt: createdAt,
    };
    await store.runs.create(run);
    for (let item = 0; item < artifactsPerRun; item += 1) {
      const at = new Date(base + index * 60_000 + item * 1_000).toISOString();
      const manifestId = `bench-manifest-${index}-${item}`;
      const manifest: Manifest = {
        manifestId,
        workspaceId: WORKSPACE_ID,
        producer: {
          agentId: AGENT_ID,
          agentVersion: "1.0.0",
          promptHash: `bench-${index}-${item}`,
          modelId: "deepseek-flash",
        },
        inputs: [],
        runId,
        stageId: `${WORKFLOW_ID}:echo`,
        runMode: "LIVE",
        cost: { currency: "CNY", amount: 0.01, tokens: 100 },
        evalRefs: [],
        approvalRefs: [],
        sensitivity: "internal",
        retentionClass: "standard",
        createdAt: at,
      };
      const artifact: ArtifactVersion = {
        artifactId: `bench-artifact-${index}-${item}`,
        version: 1,
        workspaceId: WORKSPACE_ID,
        blobId: `bench-blob-${index}-${item}`,
        manifestId,
        status: "committed",
        supersedes: null,
        supersededBy: null,
        createdAt: at,
      };
      await store.artifactStore.createCommitted(manifest, artifact);
    }
  }
}

async function readDocument(url: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeout),
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
}

async function readJson(url: string): Promise<{ seq?: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(requestTimeout),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as { seq?: number };
}

function collectAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    const href = match[1];
    if (href) {
      urls.add(href);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0] ?? "";
    if (!/rel="stylesheet"/i.test(tag)) {
      continue;
    }
    const href = /href="([^"]+)"/i.exec(tag)?.[1];
    if (href) {
      urls.add(href);
    }
  }
  return [...urls].slice(0, 200);
}

async function resolveCommitSha(): Promise<string> {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  const result = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: 10_000,
  });
  return result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : "unknown";
}

async function writeStepSummary(report: {
  mode: string;
  verdict: string;
  commitSha: string;
  firstPaint: { documentMedianMs: number; documentP95Ms: number };
  live: {
    deliveredMedianMs: number;
    deliveredP95Ms: number;
    snapshotStatements: number;
    deltaStatements: number;
  };
  bytesRatio: number;
  thresholds: {
    firstPaintP95Ms: number;
    liveP95Ms: number;
    liveBytesRatio: number;
    liveStatements: number;
    regressionFactor: number;
  };
  failures: string[];
  warnings: string[];
}): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) {
    return;
  }
  const lines = [
    "## /office perf gate (97 §5)",
    "",
    `commit \`${report.commitSha}\` · mode \`${report.mode}\` · verdict **${report.verdict}**`,
    "",
    "| metric | median | p95 | budget |",
    "|---|---|---|---|",
    `| first paint | ${report.firstPaint.documentMedianMs}ms | ${report.firstPaint.documentP95Ms}ms | ≤${report.thresholds.firstPaintP95Ms}ms |`,
    `| live update | ${report.live.deliveredMedianMs}ms | ${report.live.deliveredP95Ms}ms | ≤${report.thresholds.liveP95Ms}ms |`,
    `| live payload | ${(report.bytesRatio * 100).toFixed(2)}% | — | ≤${(report.thresholds.liveBytesRatio * 100).toFixed(0)}% of first paint |`,
    `| live statements | ${report.live.snapshotStatements}+${report.live.deltaStatements} | — | ≤${report.thresholds.liveStatements} |`,
    "",
    `Clear-regression factor: ×${report.thresholds.regressionFactor}. Artifact: \`office-perf-${report.commitSha}\`.`,
  ];
  if (report.failures.length > 0) {
    lines.push("", `**Failures:** ${report.failures.join("; ")}`);
  }
  if (report.warnings.length > 0) {
    lines.push("", `**Warnings:** ${report.warnings.join("; ")}`);
  }
  await writeFile(target, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}
