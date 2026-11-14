# Delivery and publishing

A run produces artifacts. Delivery moves the final artifact into the world:
email, a chat webhook, a local outbox, or a static site on GitHub Pages.

Delivery is a **LIVE-only** side effect. In `DRY_RUN` the system records a
`delivery` artifact with `"skipped": true` and sends nothing. Every attempt is
stored as an artifact next to the run, so you can audit what left the machine.

## Channel 1: email (SMTP)

Set the mail transport once:

```bash
KIT_SMTP_HOST=smtp.qq.com
KIT_SMTP_PORT=465
KIT_SMTP_SECURE=1
KIT_SMTP_USER=you@example.com
KIT_SMTP_PASS=your-smtp-authorization-code
KIT_DELIVERY_EMAIL_TO=you@example.com
# optional, defaults to KIT_SMTP_USER
KIT_DELIVERY_EMAIL_FROM=you@example.com
```

QQ Mail: enable SMTP in the mailbox settings and use the **authorization code**,
not the account password. Other providers use the same variables.

Declare delivery in the workflow:

```yaml
# workflows/daily-radar.yaml
delivery:
  channel: email
  approval: required_if_published
```

If `KIT_SMTP_*` or `KIT_DELIVERY_EMAIL_TO` is missing, the delivery artifact
records a failed attempt and the run still keeps its artifacts. Do not put the
password in a Team Pack; environment or secret manager only.

## Channel 2: webhook (chat, automation, or a bridge)

```bash
KIT_DELIVERY_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
KIT_DELIVERY_WEBHOOK_SECRET=replace-me   # optional HMAC
```

Payload:

```json
{ "runId": "...", "artifactId": "...", "title": "...", "markdown": "...", "sentAt": "..." }
```

With a secret, the request includes `x-kit-signature: sha256=<hmac>`. The `im`
channel is treated the same way; point it at your chat webhook. Provider-native
payloads (Feishu, DingTalk, Slack) differ — use Apprise or a small bridge if you
need exact formatting.

## Channel 3: local outbox

```yaml
delivery:
  channel: local_file
```

Writes to `%USERPROFILE%\.agent-team-kit\outbox\<runId>\<artifactId>.md`
(or `$KIT_HOME/outbox/...`). Useful for desktop flows and tests.

## GitHub Pages: publish a run as a website

```bash
kit publish <runId> --out .tmp/site        # render only
kit publish <runId> --push --yes           # render and push to gh-pages
```

What `--push` does:

1. Renders `index.html` and one page per committed artifact (tool-call artifacts
   are excluded).
2. Resolves the `origin` remote and the `gh-pages` branch (configurable with
   `--remote` and `--branch`).
3. Clones or creates the branch in a temporary directory, commits the site, and
   pushes it. Your main working tree is never touched.

Then enable Pages in the repository: **Settings → Pages → Deploy from a branch →
`gh-pages`**. The URL is `https://<owner>.github.io/<repo>/`.

Important:

- Publishing makes artifact content **public**. Pass `--yes` only after reading
  the artifacts. Secrets in artifacts are not scrubbed automatically.
- GitHub Pages for **private** repositories requires a plan that includes Pages.
  If Pages is unavailable, push the same site to a public repository or an S3/R2
  bucket instead.
- Artifacts render as escaped text (no raw HTML), so Markdown looks like
  Markdown on the static page. Rendered Markdown is a later slice.

## Safer or better options

| Option | Why |
|---|---|
| **Apprise** (open source) | One CLI/library, 100+ notification services (Feishu, Telegram, email, ntfy). Keep the webhook channel and point it at an Apprise API. |
| **ntfy / Gotify** | Self-hosted push notifications with topics, priority and attachments; no account required. |
| **Generic webhook + HMAC** (implemented) | Works with Slack/Discord/Feishu/DingTalk robots and internal automation; no new service. |
| **S3 / Cloudflare R2 / Alibaba OSS static hosting** | Better than Pages for private content, custom domains, large artifacts and versioning. Publish the generated site with `rclone` or `aws s3 sync`. |
| **RSS/Atom feed** | Turns a published site into a subscription product; readers get each new report. |
| **GitHub Releases / Gist** | Signed, versioned distribution of exports with no hosting setup. |
| **Telegram Bot API** | Simple token-based delivery for individuals; supports documents. |

Recommendation: start with **email + generic webhook**, add **Pages/R2** for
public distribution, and use **Apprise** when you need many channels without
writing adapters.

## Operability

- Delivery results are artifacts (`stageId = <artifactId>:delivery`) with
  `ok`, `channel`, `skipped`, `detail` and `target`.
- Delivery does not retry automatically today; a failed attempt is evidence, not
  a retry loop. Re-run the workflow or add a delivery retry policy later.
- `DRY_RUN` never sends. `LIVE` runs should still be gated by approvals for
  external channels.
