import path from "node:path";
import {
  buildWeb,
  clampInt,
  percentile,
  preserveGeneratedFiles,
  startProductionServer,
  tail,
} from "./bench-harness";

/**
 * Production-build benchmark for the console routes (87 §4.5).
 *
 * `bench:office` in `scripts/bench-office.ts` shares this harness; keep the
 * build/serve contract in one place so both benchmarks measure the same thing.
 */

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, "apps", "web");
const distDir = process.env.KIT_WEB_DIST_DIR ?? ".next-bench";
const samples = clampInt(process.env.BENCH_SAMPLES, 1, 20, 4);
const p50Limit = clampInt(process.env.BENCH_P50_MS, 1, 60_000, 300);
const p95Limit = clampInt(process.env.BENCH_P95_MS, 1, 120_000, 600);
const requestTimeout = clampInt(
  process.env.BENCH_TIMEOUT_MS,
  1_000,
  120_000,
  30_000,
);
const routes = (
  process.env.BENCH_ROUTES ??
  "/,/runs,/inbox,/packs,/evolution,/manager,/office,/sources,/autopilot,/traces"
)
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);

const env = {
  ...process.env,
  KIT_WEB_DIST_DIR: distDir,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
};

const generatedFiles = await preserveGeneratedFiles(webRoot);
let server: Awaited<ReturnType<typeof startProductionServer>> | undefined;

try {
  const build = await buildWeb(repoRoot, env);
  if (build.exitCode !== 0) {
    console.error("[bench] web build failed");
    console.error(tail(build.stdout));
    console.error(tail(build.stderr));
    throw new Error("web build failed");
  }

  server = await startProductionServer({ webRoot, env });
  const base = server.base;

  const results: Array<{
    route: string;
    p50: number;
    p95: number;
    samples: number[];
  }> = [];
  for (const route of routes) {
    const timings: number[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const started = performance.now();
      const response = await fetch(`${base}${route}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeout),
      });
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      if (!response.ok) {
        throw new Error(`${route} returned ${response.status}`);
      }
      if (index > 0) {
        timings.push(Math.round(elapsed));
      }
    }
    const sorted = [...timings].sort((a, b) => a - b);
    results.push({
      route,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      samples: timings,
    });
  }

  const failed = results.filter(
    (result) => result.p50 > p50Limit || result.p95 > p95Limit,
  );
  console.log(
    JSON.stringify(
      {
        mode: "production",
        distDir,
        samples,
        thresholds: { p50Ms: p50Limit, p95Ms: p95Limit },
        results,
        pass: failed.length === 0,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    console.error(
      `[bench] exceeded thresholds: ${failed
        .map((item) => `${item.route} p50=${item.p50}ms p95=${item.p95}ms`)
        .join("; ")}`,
    );
    process.exitCode = 1;
  }
} finally {
  if (server) {
    await server.stop();
  }
  await generatedFiles.restore();
}
