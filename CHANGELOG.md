# Changelog

> `1.0.0` is not released. It is gated on the unattended autonomy acceptance in
> `plans/agent-pipeline/85-autonomy-1.0.md`. The current preview is `0.9.0`.

## 0.9.0 — 2026-11-14

- Autonomy foundation: external coder adapters for DSH (live), Codex and
  OpenCode (generic CLI), isolated repository-copy sandboxes, transcript/diff
  evidence, and environment scrubbing.
- `coder` workflow stage (`type: coder`) with goal/acceptance and a 40-minute
  activity budget; the stage publishes result, transcript and diff artifacts.
- Signed event gateway (`apps/gateway`): generic HMAC and GitHub webhook
  normalization, replay/rate/body limits, canonical events on NATS.
- Runtime Event Router: matches workflow triggers (exact, prefix, `*`) and
  starts `packWorkflow` with dedupe and overlap protection.
- `kit up` / `kit down` / `kit up status`: one supervised command for Docker
  Compose, event runtime, Temporal worker, Autopilot and gateway, with restart
  and health checks.
- `kit iterate`: Planner → task plan → external coder → verify → repair →
  risk classifier → low-risk apply with commit + backup → report; evidence is
  stored as artifacts.
- `packs/self-improve/iteration.yaml`: Cyber/UX domain routing for the system
  to improve itself.
- Version reset: workspace packages and compatibility checks are `0.9.0`;
  task-centric features remain, but 1.0 is reserved for unattended operation.
- First autonomy pilot: DSH found a CWE-22 path traversal in the Pack loader
  and produced a fix plus a regression test; it was human-approved and landed
  in `3e8f586` (74 tests pass). A low-risk docs iteration was verified and
  auto-applied as `c092472` (`autonomy: docs-update (docs)`).
- Known issue: DSH's `pwsh` tool hits `SetNamedSecurityInfoW ... grantWrite
  (Win32 5)` inside the copied sandbox, so the coder cannot run shell checks
  itself; the external Verifier still runs `typecheck`/`lint`/`test`. Fix the
  sandbox ACL or move to container isolation in the next slice.
- Tests: 74 passing (coder sandbox/diff, coder stage, gateway signatures and
  normalization, router matching, iteration plan/risk, autopilot iterations,
  plus the existing suite).

## 1.0.0 — 2026-11-14 (not released)

- Task-centric team: Builder/Seller/Specialist roles, Pack-level
  `roles.requireSeller/requireBuilder/allowCombined`, and definition-of-done on
  every mission.
- Office task board: Demand → Build → Deliver → Blocked → Done, role chips,
  Seller/Builder/Specialist assignment, manager direct reports.
- `product` template: Seller → Builder → Verifier → Seller package with a final
  approval. `self-improve` pack: Cyber (`security-audit`) and UX
  (`ux-improvement`) squads for this repository.
- Controlled tool loop: model tool calls with audit artifacts over repo
  read/search/diff, static security and dependency scans, typecheck/lint/test/
  build, sandbox patch write/diff, HTTP fetch, and browser inspection adapter.
  Caps, timeouts, fixed capabilities, network/localhost policy.
- `kit patch list/apply`: apply a reviewed sandbox patch to the repository with a
  backup.
- Versioning: all workspace packages and Pack compatibility target 1.0
  (`>=0.1 <2.0`); old packs are accepted and roles are inferred.
- Tests: 46 passing (role plan, tools, product template, approval auth,
  evolution cycle, cron, Pack Studio).

## 0.3.0 — 2026-11-14

- Pack Studio: template wizard (`/packs/new`), in-browser agent/manager editor,
  raw workflow editor, per-stage approval map, autonomy editor, validation on
  every save, and `kit init --template`.
- Source market: declarative `source.yaml`, GitHub topic discovery
  (`agent-team-source`), pinned-commit installs with SHA-256, explicit consent,
  RSS/JSON adapters, SSRF guard, and CLI/UI management.
- Open approvals: stage-level `before`/`after` gates, `required`/`auto`/`never`,
  TTL, signed webhooks, automatic decision artifacts, and an external approval
  API guarded by `KIT_APPROVAL_TOKEN`.
- Autopilot: `autopilot.yaml`, cron scheduler daemon, daily run/cost budgets,
  overlap skip, auto-approval, evolution cadence, `autopilot_state` heartbeat,
  per-pack kill switches, and `/autopilot`.
- Manager Office: pixel-art office at `/office`, manager/employee sprites,
  direct reports, task assignment, mission artifacts, pack-scoped persisted
  manager chat, and links into agent editing.
- Evolution: `kit evolve cycle` and `/api/evolution/cycle` — signals → meta-agent
  proposal → champion/candidate evaluation → archive → canary; `/evolution`
  now explains the loop and shows cycle history.
- Runtime: Pack runs carry `DRY_RUN`/`LIVE`, stage approvals are policy-aware,
  and auto-approvals are audited.
- Tests: cron, Pack Studio, source schema, approval API auth, and the full
  stub evolution cycle. 36 passing.
- Docs: `docs/open-platform.md`, install/env updates, example source package.

## 0.2.0 — 2026-11-14

- Manager Console: Tailwind 4 + shadcn-style dark UI, app shell, Command Center,
  Runs, Pack detail, Evolution, and Traces pages.
- Streaming Manager chat (assistant-ui + Vercel AI SDK) grounded in run briefs,
  with artifact citation links and `manager-exchange` artifacts. No action
  tools; approvals stay explicit.
- Approval Inbox: requestId-carrying Temporal signals, stale-signal rejection,
  expiry checks, decision audit artifacts, and approve/abort from the browser.
- Web run trigger: DRY_RUN workflows from packs under `packs/`, optional pasted
  evidence, stub/live model toggle, and path whitelisting.
- Evolution console: shadow canary start/evaluate/rollback and guarded
  promotion (dry-run by default, typed confirmation to apply).
- Jaeger added to the local stack; worker `stage.run` spans carry `run.id` and
  deep-link from the console.
- Refactor: CLI/Web share `@kit/manager`, `@kit/pack`, and `@kit/evolution`.
- Security: same-origin checks on mutating routes, sanitized Markdown, no raw
  HTML or remote images, no chat-driven side effects, localhost-oriented.
- i18n: 中文 / EN switching via `next-intl` and the `NEXT_LOCALE` cookie.
  Navigation, pages, statuses, relative times, dialogs, and toasts are
  translated without changing URLs; artifact content stays original.

## 0.1.0 — 2026-11-14

- Runtime Core: event contracts, Postgres repositories, fs/S3 blob store,
  atomic artifact publish, NATS ingestion, Temporal durable execution.
- Team Pack: full validation, cost simulation, pack-driven execution.
- Quality: rubric gates, fixed DeepSeek pro judge, auto-revision (2 cycles),
  approval pause/resume.
- Sources: HN / arXiv / GitHub ingestion with `S#` citation IDs.
- Manager: structured briefs, Q&A, decision records, approval signaling.
- Glass-box: run list, run detail, artifact content and costs (read-only).
- Distribution: `kit pack export` (zip + hashed manifest), install and
  authoring docs.
