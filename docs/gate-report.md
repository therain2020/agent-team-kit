# 1.0 gate evidence report

`bun run gates:report` collects local evidence and prints a replayable report
for the 1.0 main gates defined in plan
`98-information-driven-self-manufacture.md` §5.2, with the sub-conditions from
`85-autonomy-1.0.md` §5.2. It is an evidence collector, not a release tool:
the report always sets `claimedOneZero: false` and says **1.0 is not yet
achieved** whenever any gate has a GAP.

## Run

```powershell
bun run gates:report                # human-readable report
bun run gates:report -- --json      # machine-readable report
bun run gates:report -- --out .tmp/gate-report.json
bun run gates:report -- --now 2026-11-21T12:00:00Z --json  # replay a window
bun run gates:report -- --strict    # exit 1 when any gate is a GAP
```

| Option | Default | Meaning |
|---|---|---|
| `--home <dir>` | `KIT_HOME` or `~/.agent-team-kit` | Kit home holding the store, audit and signals |
| `--repo <dir>` | this checkout | Repository root (packs, sources, cold-start package) |
| `--db <file>` | `<home>/data/kit.db` | SQLite store |
| `--packs <dir>` | `<repo>/packs` | Pack roots scanned for `.manufacture/` records |
| `--signals <dir>` | `<home>/signals` | `iterations.jsonl`, `outcomes.jsonl`, `reactions.jsonl` |
| `--sources <dir>` | `<repo>/sources` | Installed source manifests (`*.meta.json`) |
| `--reactions <file>` | `<signals>/reactions.jsonl` | Automatic reaction signals + observer sampling log |
| `--supervisor-state <file>` | `<repo>/.tmp/supervisor/state.json` | `kit up` supervisor state |
| `--days <n>` | `7` | Window length; the gate requires 7 |
| `--now <iso>` | current time | Window end; use it to replay a fixed report |

The window is the 7 UTC calendar days ending at `--now`, starting at UTC
midnight. Every record is filtered to that window inside the report builder,
so the same bundle produces the same report.

## Evidence sources

| Source id | What is read | Used by |
|---|---|---|
| `store-db` | `information_events`, `trigger_runs`, `iteration_runs/tasks`, `runs` + `artifacts`, `approvals`, `kill_switches`, `interest_profile_audits`, `activity_events`, `recovery_drills`, `last_known_good`, `incidents` | G1-G8 |
| `kitd-audit` | `<home>/audit/kitd.jsonl` (snapshot/rollback/lkg/drill actions) | G5 |
| `recovery-reports` | `<home>/audit/{recovery,rollback}-drill-*.json` (RTO and checks; the report's `script` field names the drill) | G6, G8 |
| `manufacture-proposals` | `<pack>/.manufacture/proposals/*.json` | G1, G3 |
| `components-lock` | `<pack>/components.lock.json` | G3, G8 |
| `installed-sources` | `<repo>/sources/*.meta.json` | G1 |
| `signals-iterations` | `<home>/signals/iterations.jsonl` | G4, G8 |
| `signals-outcomes` | `<home>/signals/outcomes.jsonl` | G8 |
| `reaction-samples` | `<home>/signals/reactions.jsonl` (automatic `reaction.outcome` signals, written by the reaction dispatcher, plus human usefulness samples) | G2 |
| `supervisor-state` | `.tmp/supervisor/state.json` | G8 |
| `cold-start-package` | `templates/cold-start` checks | G8 |

Every source appears in the report with `status` (`ok`, `missing`,
`unreadable`), record count and path. A missing source is itself evidence for
the GAP: the report never substitutes a default or an estimate.

## Gate mapping

| Gate | 98 §5.2 | Key evidence |
|---|---|---|
| G1 信息闭环常驻 | 1 | 7 UTC days with information events, information trigger runs, zero manual tasks, one accepted AI source proposal |
| G2 反应有效 | 2 | Automatic reaction signals linked to information trigger runs; human samples ≥ 80% useful; noise cost ≤ 20% |
| G3 资产自制造 | 3 | Accepted manufacture proposal with model draft, written files and provenance sha256 |
| G4 代码自制造 | 4 | Low/medium change applied; zero forbidden blocks; no unlinked high-risk apply |
| G5 观察者边界 | 5 | Interventions with actor and reason; routine ≤ approvals + release/budget |
| G6 恢复与不可逆 | 6 | Passing recovery drill with measured RTO ≤ 10 minutes, integrity check, no open incident |
| G7 可追溯 | 7 | event/rule/job links, artifact id, decision reference, LKG/rollback reference |
| G8 支撑条件 | 8 | 85 §5.2 conditions S1-S12, each with a derived check |

G6 uses the 1.0 target of **10 minutes** from 98 §5.2, which is stricter than
the 4-hour D-38 recovery target.

## Reading GAP entries

Each gate lists its checks and evidence. A GAP entry is
`<gate>.<check-code>` with the measured detail, for example:

```
G2.samples-linked   3/5 sample(s) link to an information trigger run
G6.rto-target       target <= 10 minute(s)
```

A GAP means the gate is **not** satisfied by current evidence. It does not
mean the feature is absent; it means no record in the sources above proves it.
To close a GAP, produce the missing record and re-run the report:

| GAP | Close by |
|---|---|
| `G1.continuity` | Let passive collection run daily for 7 days; check `information_events` |
| `G1.no-manual-tasks` | Use scheduled/information triggers instead of manual tasks |
| `G1.ai-adopted-source` | Accept a source proposal produced by the AI (I-5) |
| `G2.signals-*` | Let information reactions run (`reactToInformationEvent` writes `reaction.outcome` lines automatically) |
| `G2.*` | Record reaction samples (see below) and keep noise cost under 20% |
| `G3.*` | Run draft → dry-run → accept for an agent/workflow/pipeline/source |
| `G4.*` | Apply a low/medium iteration change; block forbidden paths |
| `G5.*` | Record actor and reason for every manual intervention; label approval risk |
| `G5.approval-risk-recorded` | Store the risk class on approval rows so they can count as high-risk approvals |
| `G6.*` | Run `bun run drill:rollback --execute` (code + instruction rollback RTO) or `bun run recovery:drill --execute --rpo-minutes <n>` (quarterly recovery/RPO) |
| `G7.*` | Keep trigger run `jobId`/`payloadRef`, artifact ids and LKG refs intact |
| `G8.S*` | See the check detail; most require probes not yet instrumented |

## Reaction sampling

`<home>/signals/reactions.jsonl` holds two record kinds, one JSON object per
line, distinguished by `kind`.

**Automatic signals** are written by the reaction dispatcher
(`packages/trigger`) at the single reaction completion point, once per
terminal decision — `fired`/`existing`/`failed`/`skipped`/
`budget-exhausted`/`cap-reached` (#259). Nothing needs to be placed by hand:

```json
{"kind":"reaction.outcome","signalId":"rsg_4f1c…","at":"2026-11-20T09:30:00.000Z","workspaceId":"default","eventId":"inf_01","ruleId":"rr_01","ruleVersion":1,"triggerRunId":"trg_01","jobId":"job_01","outcome":"fired","gate":"write-back","reason":null,"dedupeKey":"inf_01:rr_01"}
```

- `signalId` is deterministic over workspace, event, rule, trigger run and
  outcome family; a replayed event (`existing`) resolves to the same id as
  the original `fired` and is not appended twice. A failed launch keeps its
  own id so a later successful retry stays visible.
- G2 checks that at least one launched signal exists (`signals-observed`) and
  that every launched signal resolves to an information trigger run
  (`signals-linked`). Missing signals stay a GAP; nothing is synthesized.

**Human samples** carry the usefulness judgement, which cannot be derived.
They use the sample shape (no `kind`):

```json
{"at":"2026-11-20T09:30:00Z","eventId":"inf_01","triggerRunId":"trg_01","useful":true,"costCny":0.42,"note":"led to a merged fix"}
{"at":"2026-11-20T11:00:00Z","eventId":"inf_02","triggerRunId":"trg_02","useful":false,"costCny":0.08,"note":"duplicate of inf_01"}
```

Rules enforced by the report:

- `at`, `eventId` and `useful` are required on samples; `triggerRunId` must
  link to an information trigger run in the same window.
- `costCny` is required on every sample, otherwise the noise-cost ratio is a
  GAP rather than an invented number.
- Duplicate `(at, eventId, triggerRunId)` sample rows are collapsed on first
  occurrence so appending the log twice cannot move the ratio; duplicate
  signal ids are collapsed the same way.
- Lines that are neither a valid signal nor a valid sample count as corrupt.

## Traceability

G7 checks the links needed to answer event → rule → job → artifact →
decision → rollback: `trigger_runs.payload_ref`/`job_id`, an iteration or run
linked by `trigger_run_id`, an artifact id, a recorded decision and an LKG or
rollback reference. A missing link is reported as a GAP; the report does not
assert a 60-second query latency it cannot measure.

## Known limits

- Approval rows record the guarded action's risk class (`approvals.risk_class`)
  at creation: stage approvals take the pack approval policy's `riskClass`,
  change approvals mirror the proposal's `risk`, promotion approvals use the
  variant's declared class. Decisions on rows written before the column existed
  stay unlabelled and are a GAP (`G5.approval-risk-recorded`) rather than a
  guessed high-risk confirmation; automated events such as
  `ops.side_effect.blocked` are never counted as human confirmations.
- High-risk code changes have no recorded approval link yet, so any applied
  high-risk change is a GAP (`G4.high-risk-approved`).
- Zero-config (S12) reads `<home>/cold-start-tthw.json`, written by the
  bootstrap flow: the clock starts on the first `kit up` / `kit bootstrap` /
  `kit demo` (or the welcome console) and stops at the furthest milestone
  (model key accepted, or demo team produced). Model probe latency is
  excluded. A missing or incomplete ledger leaves TTHW unmeasured, so S12
  stays a GAP rather than passing on a fabricated duration.
- Concurrency (S9) reads run lease claims from `activity_events` and store
  lock acquisitions/contention from `op_log`. Factory (S11) reads batch
  approval events, and workshop (S10) reads component assembly, market
  install and DAG-save events. Each source is emitted by the production path
  that performed the action; absent rows stay GAPs.
- The collector opens the SQLite store with read queries only; it never writes
  store rows. Audit/JSONL files are read with `readFile` only.
