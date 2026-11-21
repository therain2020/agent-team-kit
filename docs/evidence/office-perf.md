# /office performance evidence (97 §5, 87 §4.5)

This is the acceptance record and operator guide for the `/office`
production-build benchmark introduced by issue #255. The plan thresholds are:

| Metric | Threshold | Source |
|---|---|---|
| `/office` first paint, production, p95 | ≤ 800 ms | 97 §5, aligned with 87/89 |
| Live agent-state update, p95 | ≤ 2 s | 97 §5 |
| Live overlay bytes vs first paint | ≤ 10 % | 97 §5 |
| Live path SQL statements | constant, bounded (≤ 4) | 97 §5, 87 §4.4 |

The benchmark lives in `scripts/bench-office.ts` (`bun run bench:office`) and
shares the production build/serve harness with `bench:web`
(`scripts/bench-harness.ts`). It runs in `.github/workflows/perf.yml`.

## Gate design

The gate is **not** a job on every PR. Shared-runner timing is noisy, and a
50 ms swing that blocks unrelated PRs would make the gate meaningless. The
workflow runs:

- **weekly schedule** (`0 3 * * 1`) — gate mode;
- **manual dispatch** — gate mode by default;
- **PRs labelled `perf`** — advisory mode: the report is published and the
  step summary is written, but the job never fails the PR.

Verdicts are three-valued:

- `pass` — every metric is within its plan threshold;
- `warn` — a metric is over the plan threshold but within
  `threshold × BENCH_REGRESSION_FACTOR` (default `1.25`); reported, not fatal;
- `fail` — a timing/byte metric is beyond `threshold × factor`, or the live
  SQL statement bound is exceeded (hard, no factor).

Only `gate` mode exits non-zero on `fail`. This is the deliberate deviation
from "always fail on threshold": it keeps the signal stable on shared runners
while still failing scheduled and manual runs on a **clear** regression.

## What is measured

Every run builds the web app once into the isolated `KIT_WEB_DIST_DIR`
(`.next-bench`), starts `next start` on a random loopback port, waits for
`/api/health`, and warms the caches. The benchmark owns its store: SQLite at
`.tmp/office-perf/state/kit.db` with the blob root beside it, so neither the
developer database nor a Postgres deployment is touched. A deterministic
scenario is seeded before the server starts: 12 runs for workflow `demo` (the
`packs/minimal` pack), 5 committed artifacts/manifests per run. The office
route is pinned to `/office?pack=minimal`.

- **First paint** — `BENCH_SAMPLES` timed `GET /office?pack=minimal` requests
  after one discarded warmup. The reported metric is the document response
  time (same definition as `bench:web` / 87 §4.5). The benchmark then fetches
  every `<script src>` and stylesheet the document references and sums those
  bytes; `firstPaint.totalBytes = html + assets`.
- **Live state update** — one `/api/world/stream?live=1` SSE connection.
  Each sample appends a synthetic activity event through `appendActivity`
  (the same choke point real runs use) and measures the time until the world
  frame carrying that `seq` arrives. The reported live metric adds the
  client's fixed 250 ms stream-batch window (`WORLD_BATCH_MS`), because that
  delay is part of the user-visible update.
- **Live overlay cost** — the initial `/api/world` snapshot bytes plus one
  delta frame, divided by `firstPaint.totalBytes`. The live path's SQL
  statements are counted in-process by wrapping the store's `sql` tag and
  invoking `loadWorldSnapshot` + `buildWorldDelta` on a synthetic event
  (the loader is documented as two constant-cost SELECTs; one more for a
  touched run).

## Report and traceability

The script writes `BENCH_REPORT` (default `.tmp/office-perf/office-perf.json`),
prints it to stdout, and appends a markdown table to
`GITHUB_STEP_SUMMARY`. The JSON carries:

- `commitSha` (`GITHUB_SHA`, or `git rev-parse HEAD` locally), `ref`,
  `workflowRun`, `generatedAt`, `runner`;
- `scenario` (route, seeded rows, sample count);
- `thresholds`, every sample, median/p95, byte counts, statement counts;
- `verdict`, `pass`, `failures`, `warnings`.

CI uploads the JSON as the `office-perf-<sha>` artifact (90-day retention),
so a result is always attributable to the commit that produced it.

## Reproduce

```powershell
bun install --frozen-lockfile
bun run bench:office          # advisory mode, human output + report file
$env:BENCH_MODE = "gate"
$env:GITHUB_SHA = (git rev-parse HEAD)
bun run bench:office          # exits 1 only on a clear regression
```

Useful knobs: `BENCH_SAMPLES` (default 20, min 5), `BENCH_OFFICE_P95_MS`
(800), `BENCH_OFFICE_LIVE_P95_MS` (2000), `BENCH_LIVE_BYTES_RATIO` (0.10),
`BENCH_LIVE_QUERY_LIMIT` (4), `BENCH_REGRESSION_FACTOR` (1.25),
`BENCH_SEED_RUNS` (12), `BENCH_SEED_ARTIFACTS` (5), `BENCH_REPORT`,
`BENCH_STATE_DIR`.

## Limitations and deviations

- **First paint is a server-response proxy.** The benchmark does not run a
  headless browser, so it measures the production document response plus the
  bytes of the assets it references, not browser paint timing. This matches
  the 87/89 definition the plan aligns with and keeps the job deterministic.
- **Live updates are synthetic by design.** Events go through the real
  activity log, projection and SSE poller, but no model or Temporal worker is
  started. The 1 s SQLite poll cadence is therefore included, which is the
  dominant, reproducible part of the 2 s budget.
- **Query attribution is partial.** The live path's statement count is
  measured exactly in-process. Attributing the full first-paint query count
  would require store-level instrumentation inside the app process; instead
  the office loader's data budget is already enforced by
  `apps/web/test/office-budget.test.ts` (≤12 runs, ≤60 manifests) in the main
  test suite, and the live-path bound is gated here.
- **Numbers are not frozen in this document.** The committed artifact from
  each run is the source of truth; the first scheduled run after this lands
  records the post-#97 baseline for `/office`.
