# Workshop: publish, install and trust

The creative workshop is a GitHub database. Repositories tagged with the topic
**`agent-team-workshop`** and a root `workshop.yaml` can be discovered,
previewed and installed by the Kit. There is no central service; the Kit only
caches the search index and stores an install record per item.

## 1. Manifest

`workshop.yaml` is the only manifest:

```yaml
apiVersion: agentteam/v1
kind: workflow            # pack | pipeline | source | template | agent | workflow | toolpack | skillpack
id: workshop-demo
name: Workshop Demo
version: 1.0.0
description: Minimal declarative workflow
license: Apache-2.0
entry: workflows/demo.yaml
files:
  - workflows/demo.yaml
topics: [demo, workflow]
permissions:
  network: false          # outbound HTTP from the item itself
  filesystem: none        # none | readonly | workspace
  code: false             # item ships executable code
```

Rules:

- `entry` must be listed in `files`; `files` must be unique and are limited to
  200 entries.
- Paths must be relative, must not contain `..`, and may only use
  `[A-Za-z0-9._/-]`.
- `permissions` declares the item's needs. The installer shows a permission
  summary before writing anything.

See `examples/workshop/demo-workflow/` for a complete sample entry.

## 2. Discover and install

CLI:

```bash
bun run kit workshop search --query demo
bun run kit workshop preview owner/repo --ref main
bun run kit workshop install owner/repo --yes --accept-unsigned
bun run kit components install owner/repo --yes --accept-unsigned
```

Web console: open `/workshop`, search the topic, click **Preview**, review trust,
permissions and the secret scan, then confirm and install.

Preview and install pin the resolved commit SHA. Nothing is executed during
preview. The destination is chosen from `manifest.kind`; every asset lands in
its own local library and is validated with that library's loader before the
install is recorded:

| kind | Destination | Result |
|---|---|---|
| `pack` | `packs/<id>/` | Loadable, runnable, visible in `/packs` |
| `pipeline` | `<host pack>/workflows/<id>.yaml` + `team.yaml` | Host workflow, registered as a pack workflow |
| `template` | `templates/<id>/` | Appears in the `/packs/new` template picker |
| `source` | `sources/<name>.yaml` + `<name>.meta.json` | Visible in `/sources`, testable |
| `agent` / `workflow` / `toolpack` / `skillpack` | `components/<kind>/<id>/` | Visible in the component library, assemblable into any host pack |

Pipeline installs require a host pack (`--host-pack <dir>`, or the host pack
field in the console). Root overrides: `--packs-root`, `--sources-root`,
`--templates-root`, `--components-root` (defaults `./packs`, `./sources`,
`./templates`, `./components`; `KIT_SOURCES_ROOT`/`KIT_TEMPLATES_ROOT`/
`KIT_COMPONENTS_ROOT` are also honoured).

Each installed item gets a `.workshop.json` record (or the source
`<name>.meta.json`) containing the repo, commit, per-file SHA-256, manifest
SHA-256, permissions, trust grade and the secret-scan result. Directory
targets are staged, validated and atomically swapped; file targets are written
atomically and rolled back on failure. The legacy `workshop/` directory is only
read for pre-M3 installs and can be imported into `packs/` from the console.

### Consent flags

| Situation | Required flag (CLI) | Web checkbox |
|---|---|---|
| Any third-party item | `--yes` | "I reviewed this item…" |
| Unsigned / unverifiable signature | `--accept-unsigned` | unsigned confirmation |
| `network: true` or `code: true` | `--accept-risk` | high-risk confirmation |
| `code: true` | `--allow-code` | code confirmation |

Without `--yes` the CLI refuses to install. The API (`installWorkshop`) enforces
the same rules independently of the UI.

## 3. Trust grades

| Grade | How it is determined |
|---|---|
| `builtin` | The manifest signature verifies against a trusted key whose `tier` is `builtin` (a first-party key). |
| `verified` | The signature verifies against any other trusted key (`tier: verified`, the default). |
| `community` | Unsigned, signed by an unknown key, or signature verification failed. |

The trust grade and the raw signature status (`valid`, `invalid`,
`unknown-key`, `missing`) are shown in the console, in `kit workshop preview`
output, and stored in `.workshop.json`.

### Trusted keys

Keys are Ed25519 public keys. Provide them in one of two ways:

1. `workshop-trusted-keys.json` in the current working directory:

   ```json
   {
     "keys": [
       {
         "keyId": "kit-2026",
         "tier": "builtin",
         "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n"
       }
     ]
   }
   ```

2. `KIT_WORKSHOP_TRUSTED_KEYS` — either a path to such a file or the inline
   JSON object.

A malformed keyring is a configuration error: preview and install fail instead
of silently downgrading everything to `community`. If no keyring is configured,
all items grade as `community`.

### Signing a manifest

The signature covers a canonical JSON form of the manifest: the `signature`
field is removed, schema defaults are applied, object keys are sorted
recursively, and the result is serialized without whitespace. Sign those UTF-8
bytes with Ed25519 and store the base64 signature:

```js
import { sign } from "node:crypto";

const payload = Buffer.from(canonical(manifestWithoutSignature), "utf8");
const value = sign(null, payload, privateKey).toString("base64");
// workshop.yaml: signature: { algorithm: ed25519, keyId: kit-2026, value: ... }
```

`canonical()` is the same stable stringify used by `canonicalManifestPayload()`
in `@kit/workshop`. Publish the public key out-of-band (this file or the env
var); never ship the private key in the repository.

## 4. Secret scanning

Every declared file, plus `workshop.yaml`, is scanned before write. A hit blocks
the install:

| Label | Example pattern |
|---|---|
| API key | `sk-…` |
| GitHub token | `ghp_…`, `github_pat_…` |
| AWS access key | `AKIA…` |
| Slack token | `xox[baprs]-…` |
| Google API key | `AIza…` |
| private key | `-----BEGIN … PRIVATE KEY-----` |

Findings report the file, line and pattern label — never the matched value.

## 5. Limits

| Limit | Value |
|---|---|
| `workshop.yaml` | 64 KB |
| Single file | 256 KB |
| Total download | 5 MB |
| File count | 200 |

These limits apply to preview and install. Install writes only inside the
destination selected by `manifest.kind` and rolls the target back on any
failure; a failed overwrite keeps the previous copy.

## 6. Publish a workshop item

1. Create a public repository whose root contains `workshop.yaml` and the files
   it declares (adapt `examples/workshop/demo-workflow/`).
2. Add the topic `agent-team-workshop` to the repository.
3. Verify locally with `kit workshop preview <owner/repo>`.
4. Optionally sign `workshop.yaml` and publish your public key so other users
   can add it to their keyring.
5. Announce the repository; the Kit queries GitHub, so no registration or push
   from the Kit is required.

Review `workshop.md`-adjacent license, permissions and any network targets
before publishing. Keep item contents declarative: code execution stays opt-in
on the installer side.
