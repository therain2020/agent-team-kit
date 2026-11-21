# Docs

- M0 D1: skeleton, contracts, CLI validation, local stack definition.
- M0 D2: Postgres repositories, fs/S3 blob backends, atomic artifact publish,
  idempotent event insert. Verified by `packages/store/test/integration.test.ts`
  on both `fs` and `s3` (MinIO via Chainguard's maintained image, pinned by
  digest because upstream removed community images in 2026).
- M0 D3: NATS JetStream adapter (durable pull consumer, msgID dedupe) and the
  event ingestor. Verified by `packages/queue/test/nats.integration.test.ts`
  and the end-to-end `apps/runtime/test/ingest.integration.test.ts` (broker
  dedupe + Postgres idempotency).
- M0 D4: Temporal two-stage workflow with heartbeat, idempotent activities, and
  a real crash-recovery smoke test (`bun run smoke:recovery`). The worker runs
  on Node/tsx because official Temporal worker support for Bun is experimental.
- M0 D5: `kit run` starts the Temporal workflow end-to-end; `kit status` shows
  runs/stages/artifacts; the Next.js glass-box lists runs and renders artifact
  content. OTel spans (`kit.run`, `stage.run`) are visible in the collector.
  M0 acceptance is complete.
- M1 authoring: full Pack validation (agents/skills/workflows/policies,
  compatibility, secret scan), cost simulation, model gateway (DeepSeek or
  stub), and the `packs/tech-radar` reference mold.
- M1.1 execution: pack-driven Temporal workflow (`packWorkflow`) maps pack
  stages to activities, calls the model gateway for agent stages, and publishes
  an artifact per stage with lineage and cost. Verified with stub flash/daily
  runs and a live DeepSeek flash run (¥0.014 total).
- M2a quality gate: gated stages evaluate the incoming draft against a rubric
  (0–1 normalized, per-dimension thresholds, fixed `deepseek-pro` judge).
  Gate results are evaluator artifacts; failures mark the run failed.
- M2b source + citation contract: HN/arXiv/GitHub ingestion into an evidence set
  with `S#` citation IDs; writer cites inline, reviewer checks, gate verifies.
  Live daily-radar passes (citations 1.0, actionability 0.9), and `deliver`
  receives the approved draft via `inputFrom`.
- M2c auto-revision: after a gate failure, the writer is re-invoked with the
  gate rationale (max 2 revisions) and the gate is re-evaluated. Verified with a
  temp pack: `SHORT DRAFT` fails gate 0, revision 1 passes (citations 1.0).
- M2d manager records: deterministic briefs (run, stages, artifacts, gate
  attempts, cost/tokens, options, risks) and decision records
  (`approve | revise | abort`) are published as artifacts.
- M2e approval pause/resume: exhausted revisions publish an ApprovalRequest,
  set the run to `paused`, and wait for a Temporal signal. `kit approve`
  records the decision and signals approve/abort; approve resumes the stage with
  `gateApproved`. Verified with a paused run that completed after approval.
- M2f manager Q&A: `kit manager ask` answers operator questions from the brief
  and report excerpt via `deepseek-pro`, cites artifact IDs, and stores the
  answer as an artifact.
- M4a distribution: `kit pack export` produces a zip with a hashed manifest;
  install/authoring docs and CHANGELOG are included.
- M5a evolution lab: variant init/propose/score/compare/promote. Non-agent files
  are hash-locked, the judge and rubric are baseline-controlled, scores are
  archived in `variants/archive.jsonl`, and promotion is dry-run by default with
  backups on `--apply`. Live baseline vs weak-writer comparison verified.
- M5b canary/auto-rollback: champion/canary state, shadow evaluation, and
  automatic rollback when pass rate or average score drops >0.1, or cost
  exceeds 1.5x champion. Verified live (weak variant: 0.00 vs 1.00 pass rate →
  `rolled_back`).
- Manager Console (UI-0–UI-5): Tailwind 4 + shadcn-style app shell, Command
  Center, L1–L4 glass-box, streaming Manager chat (assistant-ui + AI SDK),
  approval Inbox with stale/expiry guards, pack inspect/simulate/run,
  evolution actions, and Jaeger trace deep links. Verified by HTTP smoke tests,
  real DeepSeek streaming, a Web-approved paused run that resumed to
  `succeeded`, Web-triggered DRY_RUN runs, canary start/evaluate/rollback, and a
  Jaeger query by `run.id`. `packages/manager`, `packages/pack`, and
  `packages/evolution` were extracted so CLI and Web share one implementation.
- UI-6 i18n: `next-intl` cookie mode with 中文 / EN switching. All console
  chrome, status labels, relative times, dialogs and toasts are translated
  without changing URLs; artifact content remains original. Verified in both
  locales with no missing-message console errors.
- Open platform (0.3.0): Pack Studio (`/packs/new`, `/packs/<dir>/studio`),
  GitHub-topic source market, Autopilot daemon with budgets/heartbeat/
  auto-approval, pixel Manager Office with mission assignment and pack-scoped
  manager chat, stage-level approvals with an external token-guarded API, and
  the self-evolution cycle (`kit evolve cycle`). Verified by 36 tests, a
  production build, and browser E2E: Office mission completion, approval pause →
  auto-approve, evolution canary, Autopilot heartbeat, and EN/中文 switching.
- Task-centric preview (0.9.0): Builder/Seller/Specialist roles and Pack role
  rules; a Demand → Build → Deliver → Blocked → Done task board; `product` and
  `self-improve` (Cyber/UX) packs; a controlled model/tool loop over repo
  read/search/diff, static security scans, fixed checks, sandbox patches,
  HTTP fetch and browser inspection; `kit patch apply` with backups. Verified by
  the test suite, a live `repo_read` tool run, and the self-improve task board.

## Further reading

- [install.md](./install.md) — local stack, routes, environment.
- [console-ia.md](./console-ia.md) — six first-class entries and the route
  migration table.
- [open-platform.md](./open-platform.md) — Studio, market, Autopilot, Office,
  approvals, evolution, task-centric roles and controlled tools.
- [pack-authoring.md](./pack-authoring.md) — Pack layout, roles, tools,
  validation, stages, approvals, autonomy.
- [evolution-governance.md](./evolution-governance.md) — frozen eval snapshots,
  evaluator change approval, snapshot verification.
- [kill-switch.md](./kill-switch.md) — four-level kill switch, audit, console,
  CLI and drill runbook.
- [cold-start.md](./cold-start.md) — start package, conservative policy,
  checklist and evidence flow for the first 7 days.
- [gate-report.md](./gate-report.md) — rerunnable 1.0 gate evidence report,
  local sources and how to read GAP entries.
- [compose-gate.md](./compose-gate.md) — C-0 check: new input surfaces declare
  a compose kind, deterministic fallback and review step.
- `packs/self-improve/` — Cyber and UX squads for this repo.
- `examples/sources/` — publish a declarative source to the market.
- `examples/workshop/` — publish a declarative workshop item.

The planning source of truth lives outside this repository at
`D:\GitHub\plans\agent-pipeline` (not git-tracked by design).
