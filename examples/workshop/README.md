# Publish a workshop item

The Kit discovers workshop entries from the GitHub topic
**`agent-team-workshop`**. An entry is a repository with a root `workshop.yaml`
and the files it declares. Nothing is executed on preview; installation copies
the declared files and pins the resolved commit.

1. Copy `demo-workflow/` as a starting point.
2. Edit `workshop.yaml`: change `id`, `name`, `version`, `entry`, `files`,
   and declare the permissions the item really needs.
3. Add the repository topic `agent-team-workshop`.
4. Verify locally:

   ```bash
   bun run kit workshop preview <owner/repo>
   bun run kit workshop install <owner/repo> --yes --accept-unsigned
   ```

5. Optionally sign `workshop.yaml` with Ed25519 and publish the public key.
   Users who add that key to `workshop-trusted-keys.json` see the item as
   `verified` (or `builtin` for first-party keys) instead of `community`.

Keep the item declarative. `network`, `filesystem` and `code` are displayed to
users and `network`/`code` require an explicit high-risk confirmation. Secret
scans block the install if a file looks like a credential.

See `docs/workshop.md` for the full manifest, trust and signing reference.
