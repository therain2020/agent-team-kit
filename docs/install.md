# Install and run

## Prerequisites

- Bun 1.4+
- Node 24 (Temporal worker runs on Node/tsx; bun worker support is experimental)
- Docker Desktop (Postgres, MinIO, NATS, Temporal, OTel collector, Jaeger)
- Optional: DSH, Codex or OpenCode CLI for external coder tasks

## First five minutes

```bash
bun install
bun run kit doctor          # Bun, Node, Docker, ports, model key
bun run kit demo            # demo team + static plan (no Docker)
bun run kit init packs/my-team --template research
bun run kit pack simulate packs/my-team
bun run kit up --web        # console at http://localhost:3000
```

Open `/welcome` to store a model key, or run `bun run kit bootstrap`.

## Local stack

```bash
bun install
bun run kit up
bun run kit up status
```

`kit up` starts Docker Compose, the event runtime, Temporal worker, Autopilot
and the event gateway under a supervisor (logs in `.tmp/supervisor/`). Use
`--web` to also start the Manager Console; `--no-infra` if the stack is already
running. Manual fallback:

```bash
docker compose -f deploy/docker-compose.yml up -d
bun run worker
bun run apps/runtime/src/index.ts
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

For autonomous operation, the supervisor already starts Autopilot. It reads
`autopilot.yaml` from each pack, including optional `iterations:` schedules
that start `iterationWorkflow`. See [open-platform.md](./open-platform.md).

To run the self-improvement squads against this repository, use
`packs/self-improve` in `/office`:

- `security-audit` — Cyber Auditor + Patcher + Verifier + Seller.
- `ux-improvement` — UX Researcher + Frontend Builder + Verifier + Seller.

The 0.9.0 task-centric iteration loop delegates Builder work to an external
coder:

```bash
bun run kit iterate --pack packs/self-improve \
  --goal "Find one security weakness and one UX problem, fix them, verify" \
  --max-tasks 2 --live --apply low
```

`--stub` uses a deterministic security+UX plan; the coder still runs for real.
Low-risk changes are applied with a commit and backup. With
`--apply low-medium`, medium-risk changes also apply after `typecheck`,
`lint`, `test` and a production `web:build` canary; high-risk changes stay
pending. Evidence is stored as artifacts.

### Events

The gateway accepts signed generic and GitHub webhooks:

```bash
$env:KIT_EVENT_SECRET="..."   # PowerShell
bun run kit event emit --type signal.test --payload-file .tmp/event.json
```

GitHub delivery needs `GITHUB_WEBHOOK_SECRET` and a public URL/tunnel; set
`KIT_GITHUB_REPO` to allowlist one repository. Routed event runs default to
DRY_RUN until `KIT_EVENT_RUN_MODE=live`.

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
| `KIT_RUNTIME_MODE` | `scale` | `local` uses the embedded SQLite store (no Docker) |
| `KIT_DB_DRIVER` | per mode | `sqlite` or `postgres` override |
| `KIT_LOCAL_DB` | `~/.agent-team-kit/data/kit.db` | Local SQLite database file |
| `KIT_HOME` | `~/.agent-team-kit` | Bootstrap profile, key and local data |
| `KIT_DB_URL` | `postgres://kit:kit@localhost:5432/kit` | Postgres (Scale Mode) |
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
| `KIT_EVENT_SECRET` | unset | Generic webhook HMAC secret |
| `GITHUB_WEBHOOK_SECRET` | unset | GitHub webhook HMAC secret |
| `KIT_GITHUB_REPO` | unset | Optional GitHub repo allowlist (`owner/repo`) |
| `KIT_EVENT_RUN_MODE` | `dry_run` | `live` lets routed events start LIVE runs |
| `KIT_GATEWAY_PORT` | `8787` | Event gateway port |
| `KIT_CODER_CODEX_CMD` | `codex exec --full-auto -` | Codex CLI template |
| `KIT_CODER_OPENCODE_CMD` | `opencode run -` | OpenCode CLI template |
| `KIT_CODER_COMMAND` | unset | Generic coder command (stdin prompt) |
| `KIT_CODER_INSTALL` | `1` | `0` skips `bun install` in coder sandboxes |
| `KIT_CODER_KEEP` | unset | `1` keeps coder sandboxes for inspection |
| `KIT_CODER_SANDBOX_ROOT` | `%TEMP%/agent-team-kit` | external coder sandbox root (outside the repo) |
| `KIT_SIGNALS_ROOT` | `%USERPROFILE%/.agent-team-kit/signals` | iteration fitness JSONL root |
| `KIT_PROPOSALS_ROOT` | `%USERPROFILE%/.agent-team-kit/proposals` | improvement proposal output |
| `KIT_TEMPLATES_ROOT` | `./templates` | built-in template registry |
| `KIT_WORKSHOP_ROOT` | `./workshop` | workshop install root |
| `KIT_SUPERVISOR_WEB` | `0` | Set by `kit up --web` |

## Ports

Postgres 5432 · MinIO 9000/9001 · NATS 4222 · Temporal 7233 · Temporal UI 8080 ·
OTel collector 4317/4318 · Jaeger 16686 (OTLP 4319) · Manager Console 3000.

## Recovery kernel (kitd)

Install the watchdog outside the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-kitd.ps1
```

It lives at `%USERPROFILE%\.agent-team-kit`, keeps an external git bundle and
audit JSONL, and can roll back to the `lkg-0.9.0-preview` tag after three failed
health checks. `kitd status`, `kitd snapshot`, `kitd rollback -DryRun`,
`kitd watch` (kill switch: `%USERPROFILE%\.agent-team-kit\KILL`) and
`kitd install-task` are available. A real rollback refuses a dirty working
tree and preserves the bad state on a `recovery/<timestamp>` branch first.

## Stop

```bash
bun run kit down              # supervisor + compose
bun run kit down --keep-infra # supervisor only
```

Data lives in Docker volumes (`pgdata`, `miniodata`); local blobs under
`.tmp/blobs` when `KIT_BLOB_BACKEND=fs`.
