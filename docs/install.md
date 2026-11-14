# Install and run

## Prerequisites

- Bun 1.4+
- Node 24 (Temporal worker runs on Node/tsx; bun worker support is experimental)
- Docker Desktop (Postgres, MinIO, NATS, Temporal, OTel collector, Jaeger)

## Local stack

```bash
bun install
docker compose -f deploy/docker-compose.yml up -d
$env:KIT_BLOB_BACKEND="s3"   # PowerShell; use export on POSIX
```

Start the worker in one terminal:

```bash
bun run worker
```

Start the Manager Console in another (same `KIT_BLOB_BACKEND` as the worker):

```bash
bun run web:dev   # http://localhost:3000
```

The console covers the full loop:

- `/office` — task-centric Manager Office: Demand → Build → Deliver → Blocked →
  Done, Seller/Builder/Specialist assignment, manager chat, new mission.
- `/` — Command Center (exceptions first).
- `/manager` — streaming Manager chat with artifact citations.
- `/inbox` — paused approvals; approve/abort from the browser.
- `/runs/[runId]` — stage timeline, artifacts, gates, provenance.
- `/packs` — inspect, validate, simulate, run, and create teams.
- `/packs/new` — template wizard; `/packs/<dir>/studio` — edit people, pipeline,
  approvals, and autonomy.
- `/sources` — GitHub-topic source market with explicit consent.
- `/autopilot` — schedules, budgets, auto-approval, kill switch.
- `/evolution` — evolution cycles, variants, shadow canary, promote/rollback.
- `/traces` — Jaeger and Temporal deep links.

For autonomous operation, start the daemon in a third terminal:

```bash
bun run autopilot
```

It reads `autopilot.yaml` from each pack. See
[open-platform.md](./open-platform.md).

To run the self-improvement squads against this repository, use
`packs/self-improve` in `/office`:

- `security-audit` — Cyber Auditor + Patcher + Verifier + Seller.
- `ux-improvement` — UX Researcher + Frontend Builder + Verifier + Seller.

Agents can inspect the repo, run fixed checks and static scans, and write a
sandbox patch. Apply a reviewed patch with:

```bash
bun run kit patch list <runId>
bun run kit patch apply <runId> --apply
```

See [open-platform.md §7](./open-platform.md#7-task-centric-team-and-controlled-tools).

The top bar switches 中文 / EN. The choice is stored in the `NEXT_LOCALE`
cookie and keeps the current route. Artifact content remains in its original
language; only the console chrome is translated.

If the worker uses `s3`, start the web app with `KIT_BLOB_BACKEND=s3` too;
otherwise artifact content shows as unavailable while metadata still renders.

## First run

Fetch evidence and run the reference mold:

```bash
bun run kit source fetch --sources "hn,arxiv,github" --limit 5 --out .tmp/evidence.json
bun run kit pack run packs/tech-radar --workflow daily-radar --dry-run --input-file .tmp/evidence.json
bun run kit status <runId>
bun run kit manager brief <runId>
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `KIT_DB_URL` | `postgres://kit:kit@localhost:5432/kit` | Postgres |
| `KIT_BLOB_BACKEND` | `fs` | `fs` or `s3` |
| `KIT_S3_*` | MinIO defaults | S3 endpoint/bucket/credentials |
| `DEEPSEEK_API_KEY` | unset | Live model calls; otherwise stub |
| `KIT_MODEL_MODE` | auto | `stub` to force deterministic responses |
| `KIT_TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend |
| `KIT_TASK_QUEUE` | `kit-demo` | Worker task queue |
| `NEXT_PUBLIC_TEMPORAL_UI_URL` | `http://localhost:8080` | Deep links from the console |
| `NEXT_PUBLIC_JAEGER_UI_URL` | `http://localhost:16686` | Trace deep links |
| `KIT_APPROVAL_TOKEN` | unset | Enables the external approval API |
| `KIT_APPROVAL_WEBHOOK_TOKEN` | unset | Example webhook HMAC secret |
| `GITHUB_TOKEN` | unset | Higher GitHub market/search quota |
| `KIT_AUTOPILOT_DISABLED` | unset | `1` stops all autonomous ticks |
| `KIT_AUTOPILOT_INTERVAL_MS` | `30000` | Daemon tick interval |
| `KIT_SOURCES_ROOT` | `./sources` | Installed source directory |
| `KIT_TOOL_MAX_STEPS` | `10` | Model/tool loop step cap |
| `KIT_TOOL_MAX_CALLS` | `24` | Tool call cap per stage |
| `KIT_TOOLS_ALLOW_NETWORK` | unset | `1` allows external HTTP/browser |
| `KIT_TOOLS_ALLOW_LOCALHOST` | `1` | `0` blocks localhost tools |
| `KIT_BROWSE_BIN` | unset | Browser adapter binary for UX inspection |

## Ports

Postgres 5432 · MinIO 9000/9001 · NATS 4222 · Temporal 7233 · Temporal UI 8080 ·
OTel collector 4317/4318 · Jaeger 16686 (OTLP 4319) · Manager Console 3000.

## Stop

```bash
bun run dev:down
```

Data lives in Docker volumes (`pgdata`, `miniodata`); local blobs under
`.tmp/blobs` when `KIT_BLOB_BACKEND=fs`.
