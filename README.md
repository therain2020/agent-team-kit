# Agent Team Kit

**Own a private team of AI agents — with approvals, audit and rollback.**

[![ci](https://github.com/therain2020/agent-team-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/therain2020/agent-team-kit/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![status](https://img.shields.io/badge/status-0.9.0_preview-orange)
![runtime](https://img.shields.io/badge/runtime-Bun%201.4%2B-black)

Self-hosted, file-based agent teams you can run, inspect, approve and improve.
Not another agent library: a runtime plus a governance layer for teams that do
real work.

- **Teams are files** — a Team Pack is YAML and Markdown; diff it, review it, roll it back.
- **Glass box by default** — every artifact carries provenance, gates and cost.
- **Your data stays yours** — local-first, no telemetry, explicit approval for external effects.

**Start here**
- Live sample run: https://therain2020.github.io/agent-team-kit/
- First hour: `bun run kit demo` (no Docker) · zero-config: `kit bootstrap` → `/welcome`
- Create a team: `kit init my-team --template research` · [docs/pack-authoring.md](./docs/pack-authoring.md)
- Docs: [docs/install.md](./docs/install.md) · Community: [CONTRIBUTING.md](./CONTRIBUTING.md) · [SUPPORT.md](./SUPPORT.md) · [ROADMAP.md](./ROADMAP.md)
- 中文说明: [README.zh-CN.md](./README.zh-CN.md)
- Roll back one self-change by id: `powershell -File scripts\kitd.ps1 rollback -Change <id>` (dry-run) then `-Execute` · [docs/change-proposals.md#rollback-by-change-id](./docs/change-proposals.md#rollback-by-change-id)

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

Status: **Agent Team Kit 0.9.0 — autonomy preview**. Runtime, quality gates,
Manager Console, Pack Studio, source market, Autopilot, task-centric Office,
open approvals, evolution and a controlled tool loop are implemented. The
0.9.0 preview adds external coding-agent delegation (DSH / Codex / OpenCode),
a signed event gateway, a supervised `kit up` runtime, and a task-centric
iteration loop (`kit iterate`) that plans, delegates, verifies, classifies risk
and applies low-risk changes.

**1.0 is not claimed yet.** 1.0 means information-driven self-manufacture:
sources are collected continuously and drive predefined workflows, reactions
are judged effective, and the system manufactures what it needs — sources,
agents, managers, workflows, components and code (assets first, code through
sandboxed evidence and review). The operator only observes, edits and
interrupts, with recovery and audit in place. The earlier unattended operation
and self-optimization criteria remain as supporting conditions. The primary
gate is `98-information-driven-self-manufacture.md` §5.2 (plan, kept outside
this repo); see [ROADMAP.md](./ROADMAP.md) for the public gate.

## Requirements

- Bun 1.4+
- Node 24 (the Temporal worker runs on Node/tsx)
- Docker Desktop (for the local stack; `kit demo` runs without it)
- Windows / macOS / Linux
- Optional: DSH, Codex, OpenCode or Pi CLI for external coder tasks

Run `bun run kit doctor` to check all of the above.

## Quick start

```bash
bun install
bun run kit doctor          # toolchain, services, model key and coder CLIs
bun run kit demo            # demo team + static plan (no Docker required)
bun run kit init packs/my-team --template research
bun run kit up --web        # infra + runtime + worker + autopilot + gateway + console
bun run kit up status       # supervisor, children and gateway health
bun run web:dev             # console only → http://localhost:3000
bun run kit down            # stop the supervisor (and compose unless --keep-infra)
```

For the zero-config path, run `kit bootstrap` (or open `/welcome` after
`kit up --web`) and paste a model API key. `kit bootstrap` then self-checks
Docker, service ports, the model, and the external coder CLIs, printing a
copyable command for every missing item; `--install-coders` installs the
missing coder CLIs (nothing is installed without it). `/welcome` shows the
same report.

`kit up` starts a detached supervisor with restart-on-exit, health checks and
logs under `.tmp/supervisor/`. It starts Postgres, MinIO, NATS, Temporal,
Jaeger and the OTel collector through Docker Compose. Use `--no-infra` when
the stack is already running; `--web` also starts the console.

The console starts in production mode by default: the supervisor builds it
once when `.next/BUILD_ID` is missing, then runs `next start`. Set
`KIT_WEB_MODE=dev` (or pass `--web-mode dev`) to use the dev server while
editing the console.

Manual fallback (legacy):

```bash
docker compose -f deploy/docker-compose.yml up -d
bun run worker                                   # terminal A (Node/tsx)
bun run apps/runtime/src/index.ts                # terminal B (event router)
bun run kit run --pack packs/minimal --dry-run   # terminal C
bun run web:dev                                  # terminal D → http://localhost:3000
```

Services: Postgres 5432, MinIO 9000/9001, NATS 4222, Temporal 7233,
Temporal UI 8080, OTel collector 4317/4318, Jaeger 16686 (OTLP 4319).
MinIO console: http://localhost:9001 (`kit` / `kitkitkit` by default).

The web process must use the same blob backend as the worker. If the worker
uses `s3`, start the web app with `KIT_BLOB_BACKEND=s3` too; otherwise artifact
metadata renders but content shows as unavailable.

### Autonomous runtime (0.9.0 preview)

`kit up` is the supervisor. It starts the runtime event consumer, Temporal
worker, Autopilot, and the signed event gateway. Each child is restarted on
exit; the gateway is health-checked every 15 seconds. State lives in
`.tmp/supervisor/state.json`.

| Command | What it does |
|---|---|
| `kit up` | Start infra and the supervised runtime (detached) |
| `kit up --foreground` | Keep the supervisor attached to the terminal |
| `kit up status` | Show PIDs, restarts and gateway/web health |
| `kit down` | Stop supervisor and compose (`--keep-infra` keeps compose) |

The current process still needs the operator to start it; the recovery kernel
that watches `kit up` and rolls back to the last-known-good tag is the next
slice before 1.0.

### Recovery kernel (kitd)

The recovery kernel deliberately lives **outside the repository** at
`%USERPROFILE%\.agent-team-kit`, so a bad self-change cannot remove the
ability to recover.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-kitd.ps1
```

| Command | What it does |
|---|---|
| `kitd status` | supervisor + gateway (+ web) health |
| `kitd check` | one health check; writes the external audit JSONL |
| `kitd snapshot` | tag `lkg-0.9.0-preview` and create an external git bundle |
| `kitd rollback -DryRun` | show the preserved branch + reset plan |
| `kitd rollback` | preserve `recovery/<timestamp>`, reset to LKG, reinstall, restart |
| `kitd watch` | health loop; 3 failures -> rollback; `KILL` file stops the system |
| `kitd install-task` | optional Windows logon scheduled task |

Audit: `%USERPROFILE%\.agent-team-kit\audit\kitd.jsonl`.
Kill switch: `%USERPROFILE%\.agent-team-kit\KILL`.
Rollback refuses a dirty working tree; it first creates a `recovery/<timestamp>`
branch so the bad state is not lost. The current v1 is PowerShell/Windows; a
POSIX service wrapper is a later slice.

### Task-centric self-iteration

```bash
bun run kit iterate \
  --pack packs/self-improve \
  --goal "Improve security and UX with small verified changes" \
  --max-tasks 2 --live --apply low
```

Flow: Planner → task plan artifact → external coder (DSH by default) in an
isolated repository copy under `%TEMP%/agent-team-kit` (override with
`KIT_CODER_SANDBOX_ROOT`) → independent `typecheck`/`lint`/`test` → repair with
feedback → risk classifier → low-risk apply with commit + backup → report.

- `--stub` uses a deterministic three-task plan (security + UX + docs) without
  a planner model call; the coder still runs for real.
- `--apply none|low|low-medium` controls auto-apply. High-risk changes are
  never auto-applied. Agent instructions and skills (`packs/*/agents/**`,
  `packs/*/skills/**`, `skills/**`) are proposal-only in every mode: iterate
  records a blocked change proposal with the diff and verification evidence for
  the evolution plane to take over. Orchestration files
  (`packs/*/workflows/**`, `team.yaml`, `autopilot.yaml`, `policies.yaml`,
  `iteration.yaml`) are at least high risk and always need approval.
- Coder overrides: `--coder dsh|codex|opencode|command`. Codex/OpenCode commands
  can be configured with `KIT_CODER_CODEX_CMD` / `KIT_CODER_OPENCODE_CMD`.
- Evidence is stored as artifacts (`plan`, `coder.result`, `coder.transcript`,
  `coder.diff`, `verification`, `risk`, `apply`, `report`).

### Open templates and workshop

Built-in teams are data, not code: `templates/<id>/template.yaml` is validated
and listed by the CLI and the new-pack wizard.

```bash
bun run kit init .tmp/my-team --template research
bun run kit init .tmp/list --list
```

Pack Studio can list, create, rename and delete workflows; every write is
validated and `team.yaml` is updated atomically.

The GitHub workshop is topic-indexed (`agent-team-workshop`) and uses a
`workshop.yaml` manifest. Installs pin a commit, reject unsafe paths, enforce
size limits, and require explicit consent for code-bearing items.

```bash
bun run kit workshop search --query "code review"
bun run kit workshop preview acme/team-pack
bun run kit workshop install acme/team-pack --target packs --yes
```

Items with `permissions.code: true` additionally require `--allow-code`.

### Fitness signals and proposals

Each iteration publishes a `fitness` artifact and appends one JSONL line per
task to `%USERPROFILE%\.agent-team-kit\signals\iterations.jsonl` (override
`KIT_SIGNALS_ROOT`).

```bash
bun run kit signals summarize
bun run kit signals propose --dry-run
bun run kit signals propose
```

`propose` writes Markdown proposals to
`%USERPROFILE%\.agent-team-kit\proposals` for domains below 50% pass over at
least two tasks. Proposals are manual; canary/promotion remains gated.

### External events

The gateway accepts signed requests and publishes canonical events to NATS.
The runtime routes events to workflows whose `trigger.event` matches
(exact, prefix `github.*`, or `*`).

| Route | Env | Events |
|---|---|---|
| `POST /ingest/generic` | `KIT_EVENT_SECRET` | `{type, payload, occurredAt?, idempotencyKey?}` |
| `POST /ingest/github` | `GITHUB_WEBHOOK_SECRET`, optional `KIT_GITHUB_REPO` | issues, issue_comment, workflow_run, check_run, pull_request |
| `POST /ingest/sentry` | `SENTRY_WEBHOOK_SECRET` | issue created/resolved/assigned/ignored, event alert, metric alert |
| `GET /health` | — | gateway health |

```bash
$env:KIT_EVENT_SECRET="..."   # PowerShell
bun run kit event emit --type signal.test --payload-file .tmp/event.json
```

GitHub/Sentry delivery needs a public URL or tunnel. `kit event emit` uses the
same signature path locally. Set `KIT_EVENT_RUN_MODE=live` to let routed events
start LIVE runs; the default is DRY_RUN.

Sentry webhooks are verified with the `Sentry-Hook-Signature` HMAC (the raw hex
digest Sentry sends) and a stale `Sentry-Hook-Timestamp` is rejected. Alert text
stays in the event payload; it never becomes an instruction.

Before starting a workflow the router enforces a daily budget and skips while a
run of the same workflow is active. Declare it per workflow:

```yaml
trigger:
  event: sentry.issue.created
  budget:
    dailyRuns: 20
    dailyCostCny: 5
```

Workflows without a declared budget fall back to `KIT_EVENT_DAILY_RUNS` and
`KIT_EVENT_DAILY_COST_CNY`. Run counts come from the `runs` table for the UTC
day; cost comes from manifests, with the same estimate Autopilot uses.

### Autonomy boundary

The repository is fully modifiable by the system inside task sandboxes. The
recovery kernel (LKG, rollback, audit sink, kill switch) must live outside the
repository and outside the agent's write surface; otherwise one bad change can
remove the ability to recover. Product changes are classified:

| Risk | Examples | Default |
|---|---|---|
| low | docs, tests, i18n copy, non-core styles | auto-apply after checks |
| medium | non-core feature code, pages, scripts | auto in `low-medium` after checks + production build (canary gate) |
| high | runtime/orchestrator, auth, approval/apply, dependencies, deploy, secrets, `packs/*/workflows/**`, `team.yaml` | human approval |

Forbidden changes (secrets, `.git`, deleting audit/tests, escaping the sandbox)
are blocked outright. Agent instructions and skills (`packs/*/agents/**`,
`packs/*/skills/**`, `skills/**`) are never auto-applied in any mode: they stay
blocked change proposals (diff + verification evidence + reason) so the
evolution plane can evaluate and promote them. The rules live in one module
(`packages/core/src/iteration-policy.ts`) shared by classification, apply, and
autopilot.

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

Templates: `minimal`, `research`, `content`, and `product`. The browser
wizard at `/packs/new` produces the same files; `/packs/<dir>/studio` edits
them with full-pack validation on every save.

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

### Delivery and publishing

A workflow can deliver its final artifact after the run when it declares a
`delivery` block:

```yaml
delivery:
  channel: email        # email | webhook | im | local_file
  approval: required_if_published
```

- **Email** uses `KIT_SMTP_*` plus `KIT_DELIVERY_EMAIL_TO`. QQ Mail requires the
  SMTP authorization code, not the account password.
- **Webhook** posts the artifact to `KIT_DELIVERY_WEBHOOK_URL` with an optional
  HMAC signature; `im` is the same mechanism for chat robots.
- **local_file** writes to `~/.agent-team-kit/outbox`.
- `DRY_RUN` never sends. Every attempt is recorded as a `delivery` artifact.

Publish runs to a static archive and push it to GitHub Pages:

```bash
bun run kit publish <runId> --push --yes
```

The archive gets a root index, a run page with metrics and a stage timeline, and
one Markdown artifact page per artifact with provenance and a raw-content
toggle. Tool calls, gates, approvals and delivery records are excluded; artifacts
that match high-confidence secret patterns block the publish. Output lives in
`~/.agent-team-kit/publish`; repeat publishes merge into the same archive.

See [docs/delivery.md](./docs/delivery.md) for SMTP, Pages and safer alternatives.

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
| `/factory` | Pixel approval conveyor: one-key low-risk, batch low, high-risk confirmation, keyboard; `/inbox` remains the list fallback |
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
apps/cli        CLI (incl. kit up/down/iterate/event)
apps/runtime    NATS event router + Temporal workers + iteration activities
apps/gateway    Signed event gateway (generic + GitHub webhooks)
apps/web        Manager Console (glass-box + chat + approvals + runner)
packages/core   contracts (events, runs, artifacts, packs)
packages/store  Postgres repositories + fs/S3 blob adapters
packages/queue  NATS JetStream adapter
packages/workflow Temporal adapter
packages/coder  external coding-agent adapters + sandbox/diff evidence
packages/delivery email, webhook and local-outbox delivery
packages/workshop GitHub workshop manifest/search/preview/install
packages/model  model gateway (DeepSeek)
packages/manager Manager briefs, decisions, approval lookup
packages/pack   Pack loading/validation, run builder, simulation, Studio CRUD
packages/source Built-in + declarative sources, GitHub-topic market, SSRF guard
packages/autopilot Cron parser, daemon, budgets, auto-approvals, state
packages/evolution Variant lab, canary, self-evolution cycle
packages/tools  Tool registry: repo, security scans, checks, sandbox patches, web
packages/telemetry OpenTelemetry
templates/      data-driven built-in team templates
packs/minimal   minimal example Team Pack
packs/tech-radar reference mold + sample autopilot policy
packs/self-improve task-centric Cyber/UX squad + iteration.yaml routing
examples/sources example market source
deploy          docker compose + collector config
```

## Development

```bash
bun run typecheck
bun run test
bun run lint
```

## Community

- **Contribute:** [CONTRIBUTING.md](./CONTRIBUTING.md) — teams, docs, translations and code.
- **Questions:** [SUPPORT.md](./SUPPORT.md) and GitHub Discussions.
- **Security:** [SECURITY.md](./SECURITY.md) — private reports only.
- **Roadmap:** [ROADMAP.md](./ROADMAP.md).
- **Share a team:** publish a pack in your own repository and open a "Team pack submission"
  issue, or tag it with the `agent-team-workshop` topic so `kit workshop search` finds it.
- **中文说明:** [README.zh-CN.md](./README.zh-CN.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
