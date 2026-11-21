# Change proposals and the unified change pipeline

`ChangeProposal` is the single contract for both self-optimization loops
described in `85-autonomy-1.0.md` §3.5:

- **iterate** — task-centric product improvements (`@kit/iteration`,
  `@kit/engine`), substrate `code`.
- **evolve** — prompt/workflow evolution (`@kit/evolution`), substrate
  `prompt`/`skill`/`workflow`.

Before this contract each loop had its own records (`IterationTaskResult` +
`MergeTicket` vs `EvolutionCycleRecord` + `Variant`) and no shared audit or
revert semantics. Both loops now emit the same proposal shape and move it along
the same state machine.

## Contract

`packages/core/src/change.ts` defines the schema. Required fields:

| Field | Meaning |
|---|---|
| `id` | Stable proposal id; adapters derive it from the source record so replay is idempotent |
| `substrate` | `code \| prompt \| workflow \| skill` |
| `producer` | `iterate \| evolve \| human` |
| `signalRefs` | Opaque, stable refs to the signals that motivated the change |
| `hypothesis` | What should improve and why |
| `acceptance` | At least one verifiable criterion |
| `risk` | `low \| medium \| high` |
| `evalPlan` | `checks`, `evalRefs`, `snapshotRef` (frozen snapshot for evolve) |
| `revertRef` | Commit or variant the change can be rolled back to |
| `budgetRef` | Budget reservation/charge reference |
| `approvalRef` | Approval reference, mandatory for high-risk promotion |
| `outcome` | Final decision summary, actor and time |

## State machine

```
proposed → evaluating → evaluated → canary → promoted → observed
                                    └──→ promoted (low-risk direct)
any non-terminal ──→ failed | blocked ──→ rolled_back
```

- `failed` and `blocked` are explicit failure states; both are revertible.
- `rolled_back` is terminal.
- Every transition appends an immutable audit row with actor, reason and time.
- Illegal transitions throw `ChangeTransitionError`; they are never ignored.

Promotion is guarded: the proposal must be `evaluated` or `canary`, must have an
`evaluation_passed` audit row, must carry a `revertRef`, and high-risk changes
must carry an `approvalRef` (`assertPromotionAllowed`).

## Persistence (D-52)

- Rows are the source of truth: `change_proposals` and
  `change_proposal_transitions` in Postgres/SQLite (`schema-text.ts`).
- Large payloads (diffs, rendered documents) are written content-addressed to
  the blob store and referenced from `content_ref`; they are never inlined.
- Transitions are compare-and-set on `version`; the state change and its audit
  row commit in one transaction.
- The service never applies or promotes. Apply/promote keep going through the
  86 single-writer queue (`kit-apply`, cross-process apply lock).

## Shadow wiring (first version)

`@kit/change` adapters reconstruct what each loop already did and record it on
the unified machine. Wiring is opt-in and behavior-neutral:

```powershell
$env:KIT_CHANGE_PIPELINE = "shadow"   # or "on"; unset = off
```

- Default `off`: CLI output, records and tests are unchanged.
- `shadow`: iteration reports and evolution cycles additionally write proposals.
  Storage/validation failures are logged and never change the loop result.
- `on`: reserved for future enforcement (promotion bridge); currently identical
  to `shadow`.

## Evolution auto-promotion (`cycle.promote`)

An evolution cycle that auto-applies a candidate writes its promotion into the
cycle record (`promote`) and unconditionally records a `cycle.promote`
`ChangeProposal`, independently of `KIT_CHANGE_PIPELINE` (85 §3.5.6). The
proposal carries:

- `producer: evolve` and a deterministic id `chg_cy_<workspace>_<cycleId>`;
- `substrate` mapped from the variant surface (`context` → `prompt`,
  `tool` → `skill`, `architecture` → `workflow`);
- `approvalRef` when the promotion gate required an approval;
- `revert` as an `instruction` record (`targetDir`, `backupDir`, `hash`) built
  from the backup written by `promoteVariant`;
- the full state history ending in `promoted`, so `kitd` can roll it back.

If the backup cannot be read, the promotion still stands but a governance alert
is written; no false revert reference is claimed.

## Rollback by change id

Every proposal carries two related fields:

- `revertRef` — the compact display pointer (`commit:<sha>`,
  `variant:<name>`).
- `revert` — the structured, executable record. `code` keeps
  `commit`/`baseSha`/`backupDir`; `instruction` keeps the variant
  `targetDir`/`backupDir` plus a `hash` over the backup files.

The recovery kernel (`scripts/kitd.ps1`) reverts one change independently,
without touching other changes:

```powershell
# Dry-run by default: prints the plan, writes no repository/state change.
powershell -File scripts\kitd.ps1 rollback -Change chg_cy_ws_cyc_1

# Apply the rollback.
powershell -File scripts\kitd.ps1 rollback -Change chg_cy_ws_cyc_1 -Execute

# Recent proposals plus the repo-external rollback audit.
powershell -File scripts\kitd.ps1 list
```

`kitd.ps1` stays thin and calls `scripts/change-rollback.ts`, which:

- for `code`, refuses when the worktree is dirty and records the refusal;
- for `code`, runs `git revert <commit>` for exactly the recorded commit,
  which must be an ancestor of `HEAD` (another change's commit is refused);
- for `instruction`, re-verifies the backup hash before restoring files and
  tolerates dirt inside the target pack (evolution promotions are uncommitted),
  refusing only unrelated dirty paths outside it;
- acquires the same cross-process apply lock as the 86 single-writer queue;
- transitions the proposal to `rolled_back`; and
- appends one entry per attempt (dry-run, refusal, success, failure) to the
  repo-external audit `~/.agent-team-kit/audit/change-rollback.jsonl` with
  `changeId`, `actor`, substrate, and before/after state.

The audit sink sits outside the repository, alongside the recovery kernel, so
agent code cannot rewrite rollback history (D-48).

## Rollback drill

`bun run drill:rollback --execute` exercises this same executor for one code
change and one instruction change in temporary repositories and a temporary
SQLite store, measures both rollbacks and records the worst case against the G6
RTO target. See [rollback-drill.md](./rollback-drill.md).

## Bypass guard

`packages/change/test/pipeline-guard.test.ts` scans the monorepo and fails when
`applyPatchToRepo`, `applyDiffToRepo` or `promoteVariant` gains a direct call
site outside a reviewed allowlist. New code must go through `@kit/change` (and,
for writes, the single-writer queue) instead of calling the primitives.
