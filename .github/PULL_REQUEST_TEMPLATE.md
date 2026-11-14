## What and why

<!-- One paragraph. What changed, and which user moment it improves. -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs / translations
- [ ] Team pack or template
- [ ] Tooling / CI
- [ ] Refactor (no behavior change)

## Verification

<!-- Paste the commands you ran and their result. -->

```bash
bun run typecheck
bun run lint
bun run test
# for pack changes:
bun run kit pack validate <dir>
bun run kit pack simulate <dir>
```

## UI evidence

<!-- Screenshots or a short clip for console changes. Delete if not applicable. -->

## Checklist

- [ ] I did not include API keys, tokens, connection strings or private data.
- [ ] I added or updated tests for behavior changes.
- [ ] I updated the docs or translations that this change affects.
- [ ] For pack/template changes: it validates, and `README.md` explains the use case.
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md).
