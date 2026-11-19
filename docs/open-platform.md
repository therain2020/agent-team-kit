# Open platform guide

This guide covers the 0.9.0 control surface: Studio, source market, Autopilot,
task-centric Manager Office, approvals, evolution, and the controlled tool loop
with Cyber/UX domain squads.

## 1. Pack Studio

- **Create:** open `/packs/new`, pick `Minimal`, `Research`, `Content`, or
  `Product`, name the team, add employees, and create. The same result is
  available from the CLI:

  ```bash
  bun run kit init packs/my-team --template research
  ```

- **Edit:** `/packs/<dir>/studio` edits the real files under `packs/`:
  - People: manager and employees, including instructions, model, tools,
    skills, and permissions.
  - Pipeline: raw workflow YAML with live validation.
  - Approvals: per-stage gate configuration.
  - Autonomy: `autopilot.yaml`.
- Every save is validated with the full pack loader. Invalid edits are
  rejected and rolled back; the file remains the source of truth.

## 2. Source market

The market uses the GitHub topic `agent-team-source`. A source repo contains a
declarative `source.yaml` (see `examples/sources/`).

```bash
bun run kit source search
bun run kit source install owner/repo --yes
bun run kit source list
bun run kit source test <name>
bun run kit source remove <name>
```

- Install pins the resolved commit, stores a SHA-256, and requires explicit
  consent.
- Supported adapter types: `rss`, `json`, `github` (JSON with a path mapping).
- No code execution. URLs must be public HTTP(S); private/localhost targets are
  rejected. Response size is capped at 5MB.
- Set `GITHUB_TOKEN` to raise GitHub API limits. Built-ins `hn`, `arxiv`, and
  `github` always work.

## 3. Autopilot

`autopilot.yaml` lives next to `team.yaml`:

```yaml
version: 1
enabled: false
timezone: Asia/Shanghai
schedules:
  - id: daily-radar
    workflow: daily-radar
    cron: "30 6 * * *"
    mode: DRY_RUN
    inputFile: ../../.tmp/evidence.json   # relative to the pack directory
    budget: { dailyRuns: 2, dailyCostCny: 2 }
approval:
  autoApprove:
    enabled: false
    maxRisk: medium
    maxRunCostCny: 0.5
    onTimeout: wait
evolution:
  enabled: false
  cadence: weekly
  agent: writer
  evidenceFile: ../../.tmp/evidence.json
  autoApply: false
  budgetCny: 2
```

Start the daemon in its own terminal:

```bash
bun run autopilot
```

The daemon ticks every 30 seconds:
- starts due workflows (skips if the previous run is still active);
- enforces daily run/cost budgets;
- auto-approves paused requests that match the policy;
- runs the evolution cycle on its cadence;
- writes heartbeat and state to `autopilot_state`.

The console at `/autopilot` has a master kill switch, per-pack toggles, budget
usage, next run times, and recent automatic decisions. `KIT_AUTOPILOT_DISABLED=1`
is an environment-level kill switch.

## 4. Manager Office

Open `/office`:
- Click the Manager or an employee to inspect role, model, tools, status, and
  current mission.
- Manager chat is pack-scoped and persisted; it has no side-effect tools.
- “New mission” assigns a manager and employees and starts a DRY_RUN workflow.
  The assignment is recorded as a `mission-assignment` artifact.
- “Edit role” jumps to the exact agent in Studio.

The room is DOM/SVG pixel art with no game engine; it honors
`prefers-reduced-motion`.

## 5. Approvals

Any workflow stage can declare:

```yaml
approval:
  mode: required        # required | auto | never
  position: after       # before | after
  riskClass: medium     # low | medium | high
  ttl: 72h
  notify:
    webhook: https://example.com/hooks/kit
    tokenEnv: KIT_APPROVAL_WEBHOOK_TOKEN
  autoApproveWhen:
    maxRunCostCny: 0.5
    riskClass: [low, medium]
    stages: [deliver]
```

- `before` pauses before the stage; `after` pauses after its output.
- `auto` only pauses when `autoApproveWhen` is not met.
- The existing gate-failure pause remains; it honors the same risk/TTL/auto
  settings.
- Webhook requests include `x-kit-signature: sha256=<HMAC>` when `tokenEnv`
  points to a token.
- External API (requires `KIT_APPROVAL_TOKEN`):

  ```bash
  curl -X POST http://localhost:3000/api/approvals \
    -H "Authorization: Bearer $KIT_APPROVAL_TOKEN"

  curl -X POST http://localhost:3000/api/approvals/<requestId>/decision \
    -H "Authorization: Bearer $KIT_APPROVAL_TOKEN" \
    -H "content-type: application/json" \
    -d '{"decision":"approve","note":"reviewed"}'
  ```

  Decisions are idempotent by `requestId`; expired or stale requests are
  rejected. The Manager cannot approve its own request.

## 6. Evolution

Evolution improves one role at a time:

1. collect failure signals from `iterations.jsonl`, `archive.jsonl` and
   `--signal` (gate rationales, overrides, cost anomalies);
2. a meta-agent rewrites the role instructions (tools/permissions frozen);
3. champion and candidate are scored on the same evidence;
4. only improvements enter the archive and canary;
5. promotion is manual by default; `autoApply` requires a passed canary and
   creates a backup.

Each iterate run appends per-task fitness to
`$KIT_SIGNALS_ROOT/iterations.jsonl` (default
`~/.agent-team-kit/signals/iterations.jsonl`). A failed task there is enough to
start a cycle without `--force`. Point the cycle at another directory with
`--signals-root`. Cycle records include `signalRefs` (which iteration/task and
signal id were used) and `signalSources` (which files contributed), and the
hypothesis cites its source. Empty files, corrupt lines and duplicate records
are ignored deterministically.

```bash
bun run kit evolve cycle packs/tech-radar \
  --input-file .tmp/evidence.json \
  --agent writer --stub --force
bun run kit evolve cycle packs/tech-radar \
  --input-file .tmp/evidence.json --signals-root .tmp/signals
bun run kit evolve cycles
```

The `/evolution` page shows a plain-language explainer, an evolution-cycle
timeline, scores, costs, and the existing variant/canary controls. Stub mode is
for demos and deterministic tests; it cannot auto-promote.

## 7. Task-centric team and controlled tools

- Every agent has `role: builder | seller | manager | specialist`.
- Pack `roles` decides whether a task needs a Seller/Builder and whether one
  agent may fill both.
- `/office` is task-first: Demand → Build → Deliver → Blocked → Done. Each card
  shows the Seller, Builders, Specialists, acceptance definition, and run status.
- New Mission requires the Seller's definition of done, then assigns Builder(s)
  and optional Specialists.
- `packs/self-improve` applies this to the Kit itself:
  - `security-audit`: seller → cyber-auditor → patcher → verifier → seller.
  - `ux-improvement`: seller → ux-researcher → frontend-builder → verifier →
    seller.
- Tool loop: agents can call `repo_read`, `repo_search`, `repo_list`,
  `repo_diff`, `repo_typecheck`, `repo_test`, `repo_lint`, `repo_build`,
  `security_scan_code`, `security_scan_dependencies`, `workspace_write`,
  `workspace_diff`, `http_fetch`, `browser_inspect`.
- Changes are written to `.tmp/workspaces/<runId>`. Review and apply:

  ```bash
  bun run kit patch list <runId>
  bun run kit patch apply <runId> --apply
  ```

  Apply creates a `.backup/<timestamp>/` copy before writing.
- External network is denied unless LIVE or `KIT_TOOLS_ALLOW_NETWORK=1`;
  localhost is allowed unless `KIT_TOOLS_ALLOW_LOCALHOST=0`. Browser inspection
  requires `KIT_BROWSE_BIN`.
- Limits: fixed commands, no arbitrary shell; static scans are not a CVE
  database or a real penetration test; browser support depends on the adapter.

## Environment

| Variable | Purpose |
|---|---|
| `KIT_APPROVAL_TOKEN` | Enables the external approval API |
| `KIT_APPROVAL_WEBHOOK_TOKEN` | Example webhook HMAC secret |
| `GITHUB_TOKEN` | Raise GitHub market/search limits |
| `KIT_AUTOPILOT_DISABLED=1` | Global autopilot kill switch |
| `KIT_AUTOPILOT_INTERVAL_MS` | Daemon tick interval (default 30000) |
| `KIT_SOURCES_ROOT` | Installed-source directory (default `./sources`) |
| `KIT_SIGNALS_ROOT` | Iteration signal directory holding `iterations.jsonl` (default `~/.agent-team-kit/signals`) |
| `KIT_WORKSHOP_ROOT` | Installed-workshop directory (default `./workshop`) |
| `KIT_WORKSHOP_TRUSTED_KEYS` | Keyring path or inline JSON for workshop signature checks |
| `KIT_TOOL_MAX_STEPS` / `KIT_TOOL_MAX_CALLS` | Tool loop caps |
| `KIT_TOOLS_ALLOW_NETWORK` | Allow external tools (`1`) |
| `KIT_TOOLS_ALLOW_LOCALHOST` | Allow localhost tools (`0` blocks) |
| `KIT_BROWSE_BIN` | Browser adapter binary for `browser_inspect` |
