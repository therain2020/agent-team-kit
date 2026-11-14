# Contributing

Thanks for helping. This project is a self-hosted kit for private agent teams:
teams are files, runs are auditable, and every external effect needs approval.
You do not need to understand the runtime to contribute.

## Three ways to contribute

### 1. Write a team (no code)

A Team Pack is `team.yaml` plus Markdown agents, one workflow and a policy.

```bash
bun run kit init my-team --template research
bun run kit pack validate my-team
bun run kit pack simulate my-team
```

- Keep the scope small and the definition of done explicit.
- Include a `README.md` in the pack: who it is for, what it produces, what it costs.
- Add the pack under `packs/<name>/`, or share it in your own repository and open a
  "Team pack submission" issue.
- Never include API keys, tokens, customer data or internal URLs.

### 2. Improve docs and translations

- UI strings live in `apps/web/messages/en.json` and `zh.json` — keep both in sync.
- Templates live in `templates/<id>/template.yaml`; keep them readable and free of
  unexplained fields.
- Docs are in `README.md`, `docs/`, and the community files at the root.
- A docs-only PR is welcome and is a good first contribution.

### 3. Change the core

1. Open an issue first for anything larger than a bug fix.
2. Fork, branch, and run the checks below.
3. Keep pull requests focused. One concern per PR.

## Local setup

Requirements: Bun 1.4+, Node 24 (the Temporal worker runs on Node), Docker Desktop.

```bash
bun install
bun run kit doctor          # checks Bun, Node, Docker, ports and keys
bun run typecheck
bun run lint
bun run test
```

Run the console and the stack:

```bash
bun run kit up --web        # supervised stack + console
bun run web:dev             # console only, http://localhost:3000
```

Without Docker you can still work on templates and packs:

```bash
bun run kit demo            # demo team + static plan, no Docker
bun run kit init my-team --template research
bun run kit pack validate my-team
```

## Pull request rules

- `bun run typecheck`, `bun run lint` and `bun run test` must pass.
- Add a test for behavior changes. Pack and template changes must validate.
- Keep the diff small; do not include formatting-only changes in a feature PR.
- Do not commit secrets, `.env` files, local databases or generated artifacts.
- For console changes, attach a screenshot or a short clip.
- Use the PR template checklist.

## Commit messages

Use a short prefix that describes the change, for example:

```
feat: add kit doctor
fix: resolve templates relative to the package
docs: explain the zero-config path
test: cover template resolution
```

## Community expectations

- Be direct and kind. Review the code, not the person.
- Security reports go through [SECURITY.md](./SECURITY.md), never a public issue.
- By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Good first issues

Look for the `good first issue` label. Typical starter tasks include CLI messages,
console empty states, docs links, translations and small validation tests. If you
pick one up, comment on the issue so others know.
