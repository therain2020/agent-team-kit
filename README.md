# Agent Team Kit

A distributable, self-hosted kit for building private agent teams.

The kit provides:
- **Runtime Core** — events, orchestration, durable execution, artifact store, model/tool gateway.
- **Team Pack** — a declarative team definition (manager, roles, skills, workflows, policies).
- **Pack Studio** — create teams from templates; edit people, pipeline, approvals and autonomy in the browser.
- **Source market** — declarative sources discovered from the `agent-team-source` GitHub topic, pinned to a commit.
- **Autopilot** — scheduled autonomous runs with budgets, auto-approval, kill switch and heartbeat.
- **Task-centric Office** — a pixel office plus a Demand → Build → Deliver →
  Blocked → Done task board; Seller, Builder, Specialist and Manager roles.
- **Controlled tools** — repo read/search/diff, static security scans, fixed
  checks, sandbox patches, HTTP fetch, browser inspection; audited per call.
- **Self-improve pack** — Cyber and UX squads applied to this repository.
- **Open approvals** — per-stage human gates, auto-approve rules, signed webhooks and an external decision API.
- **Evolution** — failure signals → proposed role change → evaluation → canary → reversible promotion.
- **Manager Console** — glass-box, streaming Manager chat, approval inbox, pack runner, evolution and trace links.

Status: **Agent Team Kit 1.0** — runtime, quality gates, Manager Console, Pack
Studio, source market, Autopilot, task-centric Office, open approvals, evolution
and a controlled tool loop with sandbox patches are implemented. Agents can read
and search the repo, run fixed checks and static scans, and propose patches;
`kit patch apply` writes a reviewed patch with a backup. M3 cloud deployment is
deferred until credentials are available.

## Requirements

- Bun 1.4+
- Docker Desktop (for the local stack)
- Windows / macOS / Linux

## Quick start

```bash
bun install
docker compose -f deploy/docker-compose.yml up -d
$env:KIT_BLOB_BACKEND="s3"   # PowerShell

bun run worker                                   # terminal A (Node/tsx)
bun run kit run --pack packs/minimal --dry-run   # terminal B
bun run web:dev                                  # terminal C → http://localhost:3000
bun run autopilot                                # terminal D (optional, autonomous)
```

Services: Postgres 5432, MinIO 9000/9001, NATS 4222, Temporal 7233,
Temporal UI 8080, OTel collector 4317/4318, Jaeger 16686 (OTLP 4319).
MinIO console: http://localhost:9001 (`kit` / `kitkitkit` by default).

The web process must use the same blob backend as the worker. If the worker
uses `s3`, start the web app with `KIT_BLOB_BACKEND=s3` too; otherwise artifact
metadata renders but content shows as unavailable.

### Storage backends

`@kit/store` supports two blob backends:

- `fs` (default): local filesystem under `KIT_BLOB_ROOT` (`.tmp/blobs`).
- `s3`: S3-compatible storage (MinIO locally, OSS in the cloud) via `KIT_S3_*`.

Upstream MinIO removed its community Docker images from Docker Hub/Quay in 2026
and moved to source-only distribution. The compose stack therefore uses
Chainguard's maintained, non-root build (`cgr.dev/chainguard/minio`, pinned by
digest), with a one-shot `chown` init container for the data volume.

D2 was verified on **both** backends: `fs` (zero-dependency) and `s3` (MinIO).
At M3 the same `s3` adapter targets Alibaba Cloud OSS.

| Concern | `fs` | `s3` (MinIO/OSS) |
|---|---|---|
| Scope | Single host | Multiple workers/hosts |
| Setup | No service, no credentials | Bucket + credentials |
| Object atomicity | temp file + rename | native PutObject semantics |
| Durability | Local disk | Replicated object storage |
| Lifecycle / versioning / lock | Manual | Native |
| Latency | Local disk | Network |
| Fit | Local dev, single-node | Cloud, multi-worker |

Switching backends is config-only: object keys are deterministic
(`blobs/{workspaceId}/{sha256}`), so migrating existing blobs is a key-for-key
copy from `KIT_BLOB_ROOT` to the bucket.

### Runtime consumer (D3)

```bash
$env:KIT_BLOB_BACKEND="s3"
bun run apps/runtime/src/index.ts
```

| Env | Default | Purpose |
|---|---|---|
| `KIT_NATS_URL` | `nats://localhost:4222` | JetStream endpoint |
| `KIT_NATS_STREAM` | `KIT_EVENTS` | stream name |
| `KIT_NATS_SUBJECT` | `kit.events.>` | subject filter |

Publishers should set the JetStream message ID to the event's
`idempotencyKey`. The broker drops duplicates within its dedupe window; the
consumer additionally dedupes in Postgres, so restarts and replays stay safe.

### Temporal workflow (D4)

```bash
docker compose -f deploy/docker-compose.yml up -d temporal temporal-ui
bun run worker                                      # Node via tsx
bunx tsx apps/runtime/src/temporal/run-demo.ts
bun run smoke:recovery
```

- Temporal UI: http://localhost:8080
- Official Temporal TS SDK worker support is Node-only; Bun remains experimental.
  The worker is therefore launched with Node/tsx, while the rest of the Kit runs
  on Bun.
- Workflow: `prepareRun → stage-1 → stage-2 (heartbeat) → finishRun`; activities
  are idempotent per `(runId, stageId)`.
- `smoke:recovery` kills the worker during stage-2, restarts it, and asserts the
  workflow completes with exactly two artifacts (no duplicates).

### Team Pack authoring (M1)

```bash
bun run kit init packs/my-team --template research
bun run kit pack validate packs/tech-radar
bun run kit pack simulate packs/tech-radar
bun run kit model check --alias deepseek-flash
```

Templates: `minimal`, `research`, and `content`. The browser wizard at
`/packs/new` produces the same files; `/packs/<dir>/studio` edits them with
full-pack validation on every save.

- `validate` checks schema, agent/skill frontmatter, workflow/policy structure,
  references, kit compatibility, and obvious secrets.
- `simulate` estimates stage tokens/cost without touching the world; prices are
  placeholders and configurable.
- The model gateway uses `DEEPSEEK_API_KEY` when present; otherwise it falls
  back to a deterministic stub. Force stub mode with `KIT_MODEL_MODE=stub`.
- `packs/tech-radar` is the reference mold: researcher → writer → reviewer →
  delivery, plus a flash lane.

Run a pack workflow through Temporal:

```bash
bun run kit pack run packs/tech-radar --workflow flash-radar --dry-run --stub
bun run kit pack run packs/tech-radar --workflow daily-radar --dry-run
```

`--stub` forces deterministic model responses. Without it, the gateway calls
DeepSeek when `DEEPSEEK_API_KEY` is available. `kit status <runId>` now includes
manifests, token usage and CNY cost per artifact.

### Source ingestion and market (M2b)

```bash
bun run kit source fetch --sources "hn,arxiv,github" --limit 5 --out .tmp/evidence.json
bun run kit pack run packs/tech-radar --workflow daily-radar --dry-run --input-file .tmp/evidence.json

bun run kit source search
bun run kit source install owner/repo --yes
bun run kit source test <name>
```

Sources are declarative `source.yaml` files discovered from the
`agent-team-source` GitHub topic; installs pin the commit, record a SHA-256, and
require explicit consent. No source code is executed and private network
targets are rejected. See [docs/open-platform.md](./docs/open-platform.md).

- Evidence set format: `sources[]` with `citationId` (`S1…`), title, URL,
  published date and summary.
- The writer must cite `[S#]` matching `citationId`; the reviewer checks it; the
  gate verifies citations against the evidence set.
- The `deliver` stage takes the approved draft via `inputFrom: synthesize`
  (not the review).
- Live run result: pass with factuality 0.95, citations 1.0, coverage 0.9,
  structure 1.0, actionability 0.9; total cost ≈ ¥0.093.

### Quality gate (M2a)

- Gated stages evaluate the **incoming artifact** (the draft), not the review.
- Rubric thresholds are normalized to 0–1; every dimension must pass.
- The judge is fixed to `deepseek-pro`; `--stub` runs deterministic checks only.
- Gate results are published as `evaluator` artifacts. On failure, the workflow
  re-runs the writer with the gate's rationale as feedback (max 2 revisions),
  re-gates each revision, and only fails the run if all revisions fail.
- `revisionAgent` can designate a dedicated reviser; otherwise the agent that
  produced the draft is reused.

### Manager records (M2d)

```bash
bun run kit manager brief <runId>
bun run kit manager decide <runId> --option approve --note "looks good"
```

- The brief summarizes run status, stages, artifacts, every gate attempt, total
  cost/tokens, options and risks; it is stored as a `manager` artifact.
- Decisions (`approve | revise | abort`) are stored as decision-record
  artifacts with the operator as actor. They do not yet pause or mutate a run.

### Approval pause/resume (M2e)

```bash
bun run kit approve <runId> --decision approve --note "manual approval"
```

- After 2 failed revisions, the gated stage publishes an ApprovalRequest
  artifact and the run moves to `paused` (waits up to 7 days).
- `approve` signals the workflow, re-runs the stage with `gateApproved`, and
  resumes the run; `abort` fails the run.
- Decisions are recorded as decision artifacts; verified end-to-end with a
  paused run that resumed and completed after approval.

### Distribution (M4)

```bash
bun run kit pack export packs/tech-radar --out dist/tech-radar.zip
```

- The zip includes `pack.manifest.json` with a SHA-256 per file.
- Install: [docs/install.md](./docs/install.md); authoring:
  [docs/pack-authoring.md](./docs/pack-authoring.md); history:
  [CHANGELOG.md](./CHANGELOG.md).
- License: Apache-2.0. Third-party packs are untrusted code; signature
  verification (cosign) is planned and not yet enabled.

### Evolution lab (M5a)

```bash
bun run kit evolve init packs/tech-radar --out variants/baseline --name baseline
bun run kit evolve propose variants/baseline --agent writer --file writer.md \
  --out variants/writer-v2 --name writer-v2
bun run kit evolve score variants/writer-v2 --baseline packs/tech-radar \
  --input-file .tmp/evidence.json --agent writer
bun run kit evolve compare
bun run kit evolve promote variants/writer-v2 --target packs/tech-radar
```

- Only agent files may change: `team.yaml`, skills, workflows, policies and
  evals are hash-locked against the baseline.
- The judge is fixed to `deepseek-pro`; rubric definitions come from the
  baseline pack, not the variant.
- Scores are appended to `variants/archive.jsonl` (gitignored). Promotion is a
  dry-run by default; `--apply` backs up the target agent files first.
- Live example: baseline passed (citations 1.0, ¥0.058); a weak writer variant
  failed (citations 0, actionability 0.1, ¥0.029).

Canary evaluation:

```bash
bun run kit evolve canary start --baseline variants/baseline --variant variants/writer-v2 --percent 20
bun run kit evolve canary evaluate --inputs .tmp/evidence.json
bun run kit evolve canary status
bun run kit evolve canary rollback --reason "manual"
```

- Shadow-canary scores the champion and candidate on the same inputs; it
  auto-rolls back when pass rate or average score drops by more than 0.1, or
  cost exceeds 1.5x the champion.
- State lives in `variants/state.json` (gitignored). Promotion remains manual.
  Live traffic splitting is the next optional slice.

One self-evolution cycle:

```bash
bun run kit evolve cycle packs/tech-radar \
  --input-file .tmp/evidence.json --agent writer --stub --force
```

Signals → meta-agent proposal → champion/candidate evaluation → archive →
canary. The cycle is recorded in `variants/cycles.jsonl` and shown on
`/evolution`; `--auto-apply` is opt-in and never applies in stub mode.

### Autopilot

Each pack can declare `autopilot.yaml` (schedules, budgets, auto-approval,
evolution cadence). `bun run autopilot` ticks every 30s, starts due workflows,
auto-approves matching paused runs, and records heartbeat state. The console at
`/autopilot` has per-pack toggles, budget usage, the next run, auto decisions,
and a kill switch. `KIT_AUTOPILOT_DISABLED=1` stops all ticks. See
[docs/open-platform.md](./docs/open-platform.md).

### Task-centric team and tools

Agents carry `role: builder | seller | manager | specialist`; a Pack decides
whether a task requires a Seller/Builder and whether one agent may fill both.
`/office` is task-first: Demand → Build → Deliver → Blocked → Done, with the
Seller's definition of done on every card.

`packs/self-improve` applies the model to this repository:

- `security-audit`: seller → cyber-auditor → patcher → verifier → seller.
- `ux-improvement`: seller → ux-researcher → frontend-builder → verifier → seller.

The runtime supports a controlled tool loop: `repo_read`, `repo_search`,
`repo_list`, `repo_diff`, `security_scan_code`, `security_scan_dependencies`,
`repo_typecheck`, `repo_test`, `repo_lint`, `repo_build`, `workspace_write`,
`workspace_diff`, `http_fetch`, `browser_inspect`. Each call is stored as a
tool artifact. Changes go to `.tmp/workspaces/<runId>`:

```bash
bun run kit patch list <runId>
bun run kit patch apply <runId> --apply
```

Apply backs up the target files first. External network is off unless LIVE or
`KIT_TOOLS_ALLOW_NETWORK=1`; localhost is on unless
`KIT_TOOLS_ALLOW_LOCALHOST=0`; browser inspection requires `KIT_BROWSE_BIN`.

### Manager Console (UI)

```bash
$env:KIT_BLOB_BACKEND="s3"
bun run web:dev   # http://localhost:3000
```

| Route | What it does |
|---|---|
| `/office` | Task-first Manager Office: Demand/Build/Deliver/Blocked/Done board, Seller/Builder/Specialist assignment, manager chat, pixel roster |
| `/` | Command Center: exceptions, in-flight runs, spend, recent artifacts |
| `/manager` | Streaming Manager chat with artifact citations and exchange artifacts |
| `/inbox` | Paused approvals; evidence, draft, diff, approve/abort |
| `/runs/[runId]` | Stage timeline, gate evidence, artifact viewer, provenance |
| `/packs` | Inspect/validate/simulate packs; start DRY_RUN workflows; create teams |
| `/packs/new` | Template wizard for a new team |
| `/packs/[dir]/studio` | Edit agents, workflow YAML, approval nodes, autonomy |
| `/sources` | GitHub-topic source market with consent and test fetch |
| `/autopilot` | Autonomous schedules, budgets, auto-approvals, kill switch |
| `/evolution` | Evolution cycles, variants, canary evaluation, rollback, promotion |
| `/traces` | Jaeger and Temporal deep links by `run.id` |

Safety boundaries:

- The Manager chat has **no side-effect tools**. It answers; approvals happen
  only through an explicit Inbox action.
- Approval signals carry a `requestId`; the workflow ignores stale signals.
  The API also rejects expired requests and non-paused runs.
- Console run starts are DRY_RUN only and restricted to packs under `packs/`.
- Artifact Markdown disables raw HTML and remote images. There is no RBAC yet;
  the console is intended for localhost use.

#### Languages

- The top bar switches **中文 / EN**. The choice is stored in the `NEXT_LOCALE`
  cookie and survives reloads; URLs do not change.
- UI chrome, status labels, relative times, dialogs and toasts are translated.
  Artifact content, report prose, IDs, model names, and run modes stay in their
  original form.
- The Manager answers in the language of the question.

Traces: the worker emits `service.name=kit-worker` / `stage.run` spans with
`run.id`; the CLI emits `service.name=kit-cli` / `kit.run`. Jaeger UI:
http://localhost:16686. The collector still logs spans for debugging:

```bash
docker compose -f deploy/docker-compose.yml logs otel-collector
```

### Integration tests

```bash
$env:KIT_INTEGRATION="1"   # PowerShell
$env:KIT_BLOB_BACKEND="s3" # or "fs"
bunx vitest run packages/store/test/integration.test.ts
```

## Layout

```
apps/cli        CLI
apps/runtime    NATS consumer + ingestor + Temporal workers (D4)
apps/web        Manager Console (glass-box + chat + approvals + runner)
packages/core   contracts (events, runs, artifacts, packs)
packages/store  Postgres repositories + fs/S3 blob adapters
packages/queue  NATS JetStream adapter
packages/workflow Temporal adapter
packages/model  model gateway (DeepSeek)
packages/manager Manager briefs, decisions, approval lookup
packages/pack   Pack loading/validation, run builder, simulation, Studio CRUD
packages/source Built-in + declarative sources, GitHub-topic market, SSRF guard
packages/autopilot Cron parser, daemon, budgets, auto-approvals, state
packages/evolution Variant lab, canary, self-evolution cycle
packages/tools  Tool registry: repo, security scans, checks, sandbox patches, web
packages/telemetry OpenTelemetry
packs/minimal   minimal example Team Pack
packs/tech-radar reference mold + sample autopilot policy
packs/self-improve task-centric Cyber/UX squad for this repository
examples/sources example market source
deploy          docker compose + collector config
```

## Development

```bash
bun run typecheck
bun run test
bun run lint
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
