# Authoring a Team Pack

A Team Pack is the "mold": a declarative team definition that the Kit runs.
Files under `packs/` are the source of truth. Edit them in Pack Studio or with
any editor; every save through the console is validated first.

## Create

Browser: open `/packs/new`, pick `Minimal`, `Research`, `Content`, or
`Product`, name the team, add employees, and create.

CLI (same result):

```bash
bun run kit init packs/my-team --template research
```

## Edit in Pack Studio

Open `/packs/<dir>/studio`:

- **People**: manager and employees; edit description, model, tools, skills,
  permissions, and the Markdown role instructions. Saves update both
  `agents/*.md` and `team.yaml`.
- **Pipeline**: raw workflow YAML plus a stage map; validation runs before the
  file is written.
- **Approvals**: turn any stage into a human or automatic gate.
- **Autonomy**: edit `autopilot.yaml`.

## Layout

```
my-team/
├── team.yaml
├── autopilot.yaml       # optional: schedules, budgets, auto-approval
├── agents/*.md          # role instructions + frontmatter
├── skills/<name>/SKILL.md
├── workflows/*.yaml     # stage graph
├── policies/*.yaml      # autonomy levels
├── evals/rubrics.yaml
└── README.md
```

## Roles and tools

Agents declare a job family:

```yaml
role: builder | seller | manager | specialist
```

Pack-level role rules decide task gates:

```yaml
roles:
  requireSeller: true
  requireBuilder: true
  allowCombined: false
```

- Seller owns requirements, acceptance, and delivery.
- Builder owns implementation and optimization.
- Specialist is an optional verifier/researcher/auditor.
- Manager handles exceptions; it is not counted as Seller or Builder.
- Older packs without roles are inferred from ids/descriptions.

`tools` names are capabilities from `@kit/tools`:
`repo_read`, `repo_search`, `repo_list`, `repo_diff`, `repo_typecheck`,
`repo_test`, `repo_lint`, `repo_build`, `security_scan_code`,
`security_scan_dependencies`, `workspace_write`, `workspace_diff`, `http_fetch`,
`browser_inspect`.

Tool writes go to `.tmp/workspaces/<runId>`, not the real repo. Review and
apply a proposal with `kit patch list` / `kit patch apply --apply` (backup
first). External network is off unless LIVE or `KIT_TOOLS_ALLOW_NETWORK=1`;
browser inspection requires `KIT_BROWSE_BIN`. See
[open-platform.md](./open-platform.md#7-task-centric-team-and-controlled-tools).

The `product` template and `packs/self-improve` are reference implementations.

## Validate

```bash
bun run kit pack validate my-team
```

Checks schema, agent/skill frontmatter, workflow references, gate rubrics,
policies, kit compatibility, `autopilot.yaml`, and obvious secrets.

## Simulate

```bash
bun run kit pack simulate my-team
```

Estimates per-stage tokens and CNY cost without touching the world. Prices are
placeholders; token counts are fixed per agent stage.

## Workflow stages

- `type: workflow` — deterministic passthrough; zero model cost.
- `type: agent` — calls the model gateway for the referenced agent.
- `includeInitialInput: true` — passes the original evidence set alongside the
  previous stage output (needed for citation-producing writers).
- `inputFrom: <stage>` — take an earlier stage's artifact instead of the
  previous output (e.g. deliver the draft, not the review).
- `gate: evals/rubrics.yaml#<rubric>` — evaluate the incoming draft before the
  stage runs.
- `revisionAgent: <agent>` — optional dedicated reviser; defaults to the agent
  that produced the draft.

### Per-stage approval

```yaml
stages:
  - id: deliver
    type: workflow
    inputs: [radar_draft]
    outputs: [delivery_record]
    approval:
      mode: required          # required | auto | never
      position: after         # before | after
      riskClass: medium       # low | medium | high
      ttl: 72h
      autoApproveWhen:
        maxRunCostCny: 0.5
        riskClass: [low, medium]
      notify:
        webhook: https://example.com/hooks/kit
        tokenEnv: KIT_APPROVAL_WEBHOOK_TOKEN
```

- `before` pauses before the stage; `after` pauses after its output.
- `auto` only pauses when the conditions are not met.
- Gate-failure approvals honor the same risk/TTL/auto settings.
- External decisions: see [open-platform.md](./open-platform.md#5-approvals).

## Autopilot

`autopilot.yaml` next to `team.yaml` controls schedules, daily budgets,
auto-approval, and evolution cadence. Start the daemon with `bun run autopilot`;
inspect it at `/autopilot`. Full contract:
[open-platform.md](./open-platform.md#3-autopilot).

## Sources

Built-ins: `hn`, `arxiv`, `github`. Third-party sources come from the
`agent-team-source` GitHub topic as declarative `source.yaml` files:

```bash
bun run kit source search
bun run kit source install owner/repo --yes
bun run kit source test <name>
```

## Run with evidence

```bash
bun run kit source fetch --sources "hn,arxiv,github" --limit 5 --out .tmp/evidence.json
bun run kit pack run my-team --workflow daily-radar --dry-run --input-file .tmp/evidence.json
```

Gate flow: evaluate the draft → on failure, revise with feedback (max 2) →
re-gate → if still failing, publish an ApprovalRequest, set the run to `paused`
and wait for an operator or policy decision.

```bash
bun run kit manager brief <runId>
bun run kit manager ask <runId> "What are the top risks?"
bun run kit approve <runId> --decision approve --note "reviewed"
```

## Evolution

```bash
bun run kit evolve cycle packs/my-team \
  --input-file .tmp/evidence.json --agent writer --stub --force
```

Signals → proposal → evaluation → archive → canary; promotion is manual unless
`autoApply` is explicitly enabled. See `/evolution`.

## Export

```bash
bun run kit pack export my-team --out dist/my-team-1.0.0.zip
```

The zip contains `pack.manifest.json` with a SHA-256 per file.

## Trust levels

- Built-in/reference packs are shipped with the Kit.
- Third-party packs are untrusted code: validate, review, and run them in a
  sandbox with least privilege. Signature verification (cosign) is planned for a
  later milestone; until then, do not install packs from untrusted sources.
