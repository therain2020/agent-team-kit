# Publish a source to the market

The Kit discovers sources from GitHub topic **`agent-team-source`**. A source is
declarative data — no code is downloaded or executed.

1. Create a public GitHub repository with `source.yaml` at the root (copy
   `arxiv-cs-ai/source.yaml` as a starting point).
2. Add the topic `agent-team-source` to the repository.
3. Verify it locally:

   ```bash
   bun run kit source search --query arxiv
   bun run kit source install <owner/repo> --yes
   bun run kit source test <name>
   ```

4. Review the ToS/robots/attribution fields in `compliance`. The Kit pins the
   current commit, stores a SHA-256, and rejects private network targets.

Users install with an explicit confirmation ("I reviewed source.yaml"). Treat
third-party sources as untrusted; the Kit blocks arbitrary code and private
addresses, but the content itself can still be wrong or misleading.
