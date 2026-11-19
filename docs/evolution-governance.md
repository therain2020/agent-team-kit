# Evolution governance: frozen eval snapshots

`kit evolve cycle` freezes the evaluator inputs before it proposes, scores or
promotes anything. The cycle then evaluates the baseline, candidate and canary
only against that frozen copy.

## Signal sources

A cycle starts from failure signals gathered from three adapters:

- `iterations.jsonl` — per-task fitness written by each iterate run. The file
  lives under `KIT_SIGNALS_ROOT` (default `~/.agent-team-kit/signals`); override
  it per invocation with `evolve cycle --signals-root <dir>` or point at a
  specific file with the `iterationsPath` option. Only tasks where
  `verified: false` become failure signals.
- `archive.jsonl` — failed variant scores recorded by earlier cycles.
- `--signal <text>` — operator-supplied signals.

The adapters merge, deduplicate and truncate to the eight most recent signals
before the hypothesis is generated. Missing or empty files contribute nothing;
blank lines, corrupt JSON and structurally invalid records are skipped. A
duplicate record (same iteration, task and timestamp) is collapsed on first
occurrence, so replaying or appending the same line twice cannot skew a cycle.

Each cycle record stores `signalRefs` (one entry per used signal: `signalId`,
source, and for iterations the `iterationId`/`taskId`/`domain`) and
`signalSources` (the files that contributed, e.g.
`iterations:/home/me/.agent-team-kit/signals/iterations.jsonl`). The generated
hypothesis cites the sources and the most recent iterations directly. With no
signals and no `--force`, the cycle is still skipped.

JSONL files are an adapter layer only. Postgres remains the durable, queryable
source of truth for evolution records (D-52); a unified evidence layer is
expected to replace these files later.

## Snapshot layout

```
<cycles-root>/<cycleId>/eval/
  evals/            # copied from the pack (visible material only)
  fixtures/         # copied when the pack has one
  hidden/           # frozen copy of the hidden suite (outside the pack)
  manifest.json     # relative path, sha256 and size for every file
  manifest.sha256   # hash of manifest.json
<cycles-root>/hidden-audit.jsonl   # hidden-set access audit (outside the repo)
```

Pack-local eval material lives under `evals/visible/` and may ship inside
packs and variants. Packs written before this layout keep the rubric at
`evals/rubrics.yaml`; both resolve identically at score time. Anything that
must not be visible to the candidate (hidden cases, adversarial probes) lives
outside the repository.

The default root is `%USERPROFILE%\.agent-team-kit\cycles`
(`~/.agent-team-kit/cycles`). Override it with `KIT_EVOLUTION_CYCLES_ROOT` or
`--cycles-root`. The root must live outside the pack and the working tree;
otherwise the cycle refuses to start.

Files are marked read-only where the OS honors POSIX modes. Hash verification is
the hard guard: `scoreVariant` re-verifies the manifest before every score, so
editing the live pack or the snapshot fails the cycle instead of silently
changing the rubric.

## Evaluator changes

`EVALUATOR_VERSION` plus the frozen `evals/` tree form the `evaluatorHash`. A
cycle that sees a different hash from the previous cycle is skipped:

```text
evolve cycle packs/tech-radar --input-file .tmp/evidence.json \
  --approve-evaluator-change --approval-ref <approval-id>
```

The approval reference is stored on the cycle. The change applies only to the
new cycle; earlier snapshots are never rewritten. A skipped cycle does not
create a snapshot, so an unapproved evaluator cannot become the new baseline.

## Verify

```text
kit evolve snapshot verify <cycleId> [--cycles-root <dir>]
```

The command recomputes every file hash and the manifest hash and exits non-zero
on mismatch. Cycle records persist `evalSnapshotPath`, `evalSnapshotHash`,
`evaluatorHash` and, when approved, `evaluatorApprovalRef`.

## Hidden eval sets

Hidden cases are the Goodhart defence from 70 §3.4 and 40 §3.3: they are
physical neighbours of neither packs nor variants.

### Directory convention

```
<hidden-root>/<workspace>/suite.yaml
```

`<hidden-root>` defaults to `~/.agent-team-kit/hidden-evals` and can be
overridden with `KIT_HIDDEN_EVALS_ROOT`. `<workspace>` is the sanitized
workspace id. `evolve cycle` picks this directory up automatically when it
exists; `--hidden-evals <dir>` overrides it for one run. The directory must
live outside the pack, outside the snapshot destination and outside the
repository, otherwise the cycle refuses to freeze.

Tests and drills must inject a temporary root; they must never read or write
the real home directory.

### Suite format

```yaml
version: 1
rotation:
  periodDays: 7        # rotation window (default 7)
  size: 2              # cases per chunk; defaults to the whole suite
  seed: optional-stable-seed
cases:
  - id: hidden-0001
    kind: standard      # or "adversarial" (default: standard)
    evidence: |
      Evidence handed to the agent under test.
    expect:
      contains: ["[S1]"]        # all must appear in the draft
      excludes: ["as an AI"]    # none may appear
```

Case ids must be unique, evidence non-empty, and `kind` either `standard` or
`adversarial`.

### Rotation

The suite is ordered by `sha256(seed-or-suite-hash + ":" + case-id)` and split
into disjoint chunks of `rotation.size`. The rotation epoch is
`floor(now / periodDays)`, and each epoch uses exactly one chunk
(`chunkIndex = epoch % chunkCount`). Subsets therefore never overlap across
consecutive epochs: a case judged last week is not judged this week, so a
candidate cannot tune to the cases it saw. The selection is recorded on the
snapshot manifest under `hidden` (suite hash, epoch, period, chunk index and
count, selected case ids, `rotatedAt`); scoring re-reads the suite, checks the
hash and judges only `selectedCaseIds`.

The hidden set does not feed `evaluatorHash`, because it rotates independently
of the evaluator and must not require an evaluator approval every window.

### Scoring and blocking

`scoreVariant` always applies the visible rubric. When the snapshot carries a
hidden suite it also runs the rotated subset against the agent and adds
aggregate dimensions only: `scores.hidden` (pass ratio) and
`scores.hiddenAdversarial` (1 when no adversarial case failed). Any failed
`adversarial` case flips `pass` to false, which rejects the cycle before the
canary stage and blocks promotion. Only counts appear in `rationale`; case
texts and ids never reach packs, variants, cycle records, logs or the console.

### Audit

Every hidden access appends one JSON line to
`<cycles-root>/hidden-audit.jsonl`: timestamp, action (`select` at freeze,
`score` at evaluation), cycle id, workspace, suite hash, rotation epoch and the
selected case ids. The sink is outside the repository and outside the frozen
snapshot. If the audit cannot be written, the access fails closed.

### Degradation

Without a hidden suite the cycle runs on the visible rubric only and marks the
gap: `manifest.hidden = { available: false }`, no `scores.hidden`, and
`rationale` ends with `hidden coverage unavailable`. This keeps the cycle
usable while making missing coverage visible in the records.

## Canary

`startCanary` stores `evalSnapshotPath` on the canary state and
`evaluateCanary` reuses it, so manual canary evaluation cannot fall back to a
mutable rubric.

## Security invariants

`packages/evolution/src/security-invariants.ts` makes the evolution-plane
invariants executable. Each probe carries a stable id so a failure points at
the rule it protects (70 §3.3/§5, 85 §3.6, 50 §3.8):

| Id | Invariant | Enforcement |
|---|---|---|
| SEC-INV-01 | Agent writes to the recovery kernel, LKG or audit sink are rejected | `describeRecoverySurface` + `classifyProtectedWrite` against `<KIT_HOME>/bin`, `/audit`, `/state` and `KILL`; `evaluatePatchSecurity` refuses absolute or `..` patch paths |
| SEC-INV-02 | Changes that disable audit or approval are blocked | `detectControlPlaneDisable` (config/flag forms) and `detectControlPlaneDeletion` (audit/approval code or tests) |
| SEC-INV-03 | Eval snapshots live only in the external kit home | `assertSnapshotRootAllowed`; `createEvalSnapshot` rejects a root outside `KIT_HOME` or inside the repository when `kitHome` is supplied, and agents may not write under `<KIT_HOME>/cycles` |
| SEC-INV-04 | Frozen eval snapshots fail closed when tampered | `assertFrozenSnapshotIntact` on top of the manifest hash check, plus a read-only write probe (Windows read-only attribute / POSIX 0444) |

The probes are injectable (`kitHome`, `repoRoot`, temp roots); the tests never
read or write the operator's real home. Run the gate with:

```text
bun run test:invariants
```

CI runs it before the full suite, so an invariant failure blocks the PR.

## Follow-ups

- Goodhart divergence and drift re-evaluation: E3 (#28).
- Incident freeze and convergence: E4 (#29).
