# kit-self-build

The team that changes this repository (its own code and assets). Plan basis:
98 §3.4 / §6 I-7, 84 §3.5, 85 §3.4. It does not replace `self-improve`: that
pack keeps the Cyber/UX domain missions; this one is the self-manufacture loop.

`self-improve` = domain work on the product. `kit-self-build` = the system
improving itself, with the same sandbox, verification and risk gates.

## Roles

| agent | role | job | prompt stance |
|---|---|---|---|
| `architect` | specialist | research, options, one recommendation, ADR/proposal — never implements | research first, state long-term cost |
| `frontend-designer` | builder | creative frontend: research current practice, then a usable, accessible, fast UI | research first, options + reasons |
| `backend-designer` | builder | grounded backend: safest option, full reasoning chain, reversible/observable/testable | research first, options + reasons |
| `critic` | seller | demanding user and seller gate: concrete objections + acceptance criteria | research first, never fabricates |
| `verifier` | specialist | independent validation: typecheck/lint/test/build/scan, distrusts self-reports | evidence only |
| `manager` | manager | priorities, budget, exceptions, escalation — not the definition of done | never fabricates |

`roles.requireSeller=true`, `roles.allowCombined=false`: the `critic` (seller) and
the designers (builder) are different agents.

## Workflow (`self-build`)

```text
intake -> architect -> (frontend-design || backend-design) -> critic -> build -> verify -> observe
```

- **critic is the seller gate.** The `critic` stage is bound to the
  `evals/self-build-rubrics.yaml#critic` rubric. A design that cannot clear the
  rubric after the architect's revisions is a hard stop (`approval.mode: never`),
  so `build`, `verify` and `observe` can never run on a rejected design. The
  critic agent then records the explicit ACCEPT/REJECT verdict and acceptance
  criteria that the Builders work against.
- **verifier is independent.** It re-runs the checks against the critic's
  acceptance criteria and never trusts the Builders' self-reports.

## Code changes (85)

Code is produced by the external coder (`dsh`) in an isolated sandbox — the
`build` stage only returns a transcript and a diff. Applying is a separate step
that goes through the existing iteration path (`packages/iteration`,
`packages/core/src/iteration-policy.ts`):

- low / medium risk → auto-merge once verification passes (`--apply low-medium`);
- high risk → approval;
- forbidden paths (`.git`, `.env`, `node_modules`, agent/skill instructions) →
  blocked before apply, no exception.

`iteration.yaml` maps the `frontend`, `backend` and `docs` domains to this
workflow, the coder and the verification checks. Its `autoApply` block records
the intended boundary; the runtime knob is still the CLI apply mode.

## Asset changes (98 I-5 / I-6)

Agent / workflow / pipeline / component / source changes are **proposals**, not
code edits. They go through `packages/job/src/manufacture.ts`
(`draftManufacture → validateDraft → dryRunManufacture → acceptManufacture`, with
`rollbackManufacture` on failure) and 88/94 gates. This pack does not carry a
second apply path.

## Observer controls

Pause / kill / rollback / edit and high-risk approval are the observer's powers
(98 §3.5). They are delivered by the runtime recovery kernel (85) and the
observer surfaces tracked in #134 / #135; this pack deliberately adds no bypass.

## Run

```bash
bun run kit pack validate packs/kit-self-build
bun run kit pack simulate packs/kit-self-build
bun run kit pack run packs/kit-self-build --workflow self-build --dry-run --stub

# code self-build through the existing coder + risk path
bun run kit iterate --pack packs/kit-self-build --goal "..." --live --apply low-medium
```

`autopilot.yaml` ships `enabled: false`; enable it only after a green dry run.

## TODO / follow-up

- **scout (#130).** The plan graph is `intake -> scout -> architect -> ...`, but
  the `scout` agent, its tool loop and its source permissions are owned by #130.
  `scout.md` is intentionally not created here to avoid a same-file conflict;
  `architect` performs its research-first pass in the meantime. When #130 lands,
  insert a gated `scout` agent stage between `intake` and `architect` and add
  `scout` to `team.yaml`.
