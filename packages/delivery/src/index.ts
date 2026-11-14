import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";

export type DeliveryChannel = "email" | "webhook" | "im" | "local_file";

export interface DeliveryInput {
  channel: DeliveryChannel;
  runId: string;
  artifactId: string;
  title: string;
  markdown: string;
  runMode: "DRY_RUN" | "LIVE";
  env?: Record<string, string | undefined>;
}

export interface DeliveryResult {
  ok: boolean;
  channel: DeliveryChannel;
  skipped: boolean;
  detail: string;
  target?: string;
}

export type NotificationChannel = "email" | "im" | "webhook";

export interface NotificationInput {
  channel: NotificationChannel;
  subject: string;
  text: string;
  dryRun?: boolean;
  meta?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export async function deliverNotification(
  input: NotificationInput,
): Promise<DeliveryResult> {
  const env = input.env ?? process.env;

  if (input.dryRun) {
    return {
      ok: true,
      channel: input.channel,
      skipped: true,
      detail: "dry run; notification was not sent",
    };
  }

  switch (input.channel) {
    case "email":
      return sendNotificationEmail(input, env);
    case "im":
    case "webhook":
      return sendNotificationWebhook(input, env);
  }

  return {
    ok: false,
    channel: input.channel,
    skipped: false,
    detail: `unsupported notification channel: ${input.channel}`,
  };
}

async function sendNotificationEmail(
  input: NotificationInput,
  env: Record<string, string | undefined>,
): Promise<DeliveryResult> {
  const host = env.KIT_SMTP_HOST;
  const user = env.KIT_SMTP_USER;
  const pass = env.KIT_SMTP_PASS ?? env["SMTP-AgentTeamKit"];
  const to = env.KIT_DELIVERY_EMAIL_TO;

  if (!host || !user || !pass || !to) {
    return {
      ok: false,
      channel: "email",
      skipped: false,
      detail:
        "missing SMTP config: set KIT_SMTP_HOST, KIT_SMTP_USER, KIT_SMTP_PASS (or SMTP-AgentTeamKit) and KIT_DELIVERY_EMAIL_TO",
    };
  }

  const transport = nodemailer.createTransport({
    host,
    port: Number(env.KIT_SMTP_PORT ?? "465"),
    secure: env.KIT_SMTP_SECURE !== "0",
    auth: { user, pass },
  });

  try {
    const info = await transport.sendMail({
      from: env.KIT_DELIVERY_EMAIL_FROM ?? user,
      to: to
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", "),
      subject: `[Agent Team Kit] ${input.subject}`,
      text: input.text,
      html: renderNotificationHtml(input),
    });
    return {
      ok: true,
      channel: "email",
      skipped: false,
      detail: `delivered to ${info.accepted?.length ?? 0} recipient(s)`,
      target: to,
    };
  } catch (error) {
    return {
      ok: false,
      channel: "email",
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    transport.close();
  }
}

async function sendNotificationWebhook(
  input: NotificationInput,
  env: Record<string, string | undefined>,
): Promise<DeliveryResult> {
  const url = env.KIT_DELIVERY_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      channel: input.channel,
      skipped: false,
      detail: "missing KIT_DELIVERY_WEBHOOK_URL",
    };
  }

  const body = JSON.stringify({
    subject: input.subject,
    text: input.text,
    meta: input.meta ?? {},
    sentAt: new Date().toISOString(),
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const secret = env.KIT_DELIVERY_WEBHOOK_SECRET;
  if (secret) {
    headers["x-kit-signature"] = `sha256=${createHmac("sha256", secret)
      .update(body)
      .digest("hex")}`;
  }

  try {
    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return {
        ok: false,
        channel: input.channel,
        skipped: false,
        detail: `webhook returned HTTP ${response.status}`,
        target: url,
      };
    }
    return {
      ok: true,
      channel: input.channel,
      skipped: false,
      detail: `webhook returned HTTP ${response.status}`,
      target: url,
    };
  } catch (error) {
    return {
      ok: false,
      channel: input.channel,
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
      target: url,
    };
  }
}

export async function deliverArtifact(
  input: DeliveryInput,
): Promise<DeliveryResult> {
  const env = input.env ?? process.env;

  if (input.runMode !== "LIVE") {
    return {
      ok: true,
      channel: input.channel,
      skipped: true,
      detail: "run mode is DRY_RUN; no external delivery was attempted",
    };
  }

  switch (input.channel) {
    case "email":
      return sendEmail(input, env);
    case "webhook":
    case "im":
      return sendWebhook(input, env);
    case "local_file":
      return writeLocal(input, env);
  }

  return {
    ok: false,
    channel: input.channel,
    skipped: false,
    detail: `unsupported delivery channel: ${input.channel}`,
  };
}

async function sendEmail(
  input: DeliveryInput,
  env: Record<string, string | undefined>,
): Promise<DeliveryResult> {
  const host = env.KIT_SMTP_HOST;
  const user = env.KIT_SMTP_USER;
  const pass = env.KIT_SMTP_PASS ?? env["SMTP-AgentTeamKit"];
  const to = env.KIT_DELIVERY_EMAIL_TO;

  if (!host || !user || !pass || !to) {
    return {
      ok: false,
      channel: "email",
      skipped: false,
      detail:
        "missing SMTP config: set KIT_SMTP_HOST, KIT_SMTP_USER, KIT_SMTP_PASS (or SMTP-AgentTeamKit) and KIT_DELIVERY_EMAIL_TO",
    };
  }

  const transport = nodemailer.createTransport({
    host,
    port: Number(env.KIT_SMTP_PORT ?? "465"),
    secure: env.KIT_SMTP_SECURE !== "0",
    auth: { user, pass },
  });

  try {
    const info = await transport.sendMail({
      from: env.KIT_DELIVERY_EMAIL_FROM ?? user,
      to: to
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", "),
      subject: `[Agent Team Kit] ${input.title} · ${input.runId}`,
      text: input.markdown,
      html: renderEmailHtml(input),
    });
    return {
      ok: true,
      channel: "email",
      skipped: false,
      detail: `delivered to ${info.accepted?.length ?? 0} recipient(s)`,
      target: to,
    };
  } catch (error) {
    return {
      ok: false,
      channel: "email",
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    transport.close();
  }
}

async function sendWebhook(
  input: DeliveryInput,
  env: Record<string, string | undefined>,
): Promise<DeliveryResult> {
  const url = env.KIT_DELIVERY_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      channel: input.channel,
      skipped: false,
      detail: "missing KIT_DELIVERY_WEBHOOK_URL",
    };
  }

  const body = JSON.stringify({
    runId: input.runId,
    artifactId: input.artifactId,
    title: input.title,
    markdown: input.markdown,
    sentAt: new Date().toISOString(),
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const secret = env.KIT_DELIVERY_WEBHOOK_SECRET;
  if (secret) {
    headers["x-kit-signature"] = `sha256=${createHmac("sha256", secret)
      .update(body)
      .digest("hex")}`;
  }

  try {
    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return {
        ok: false,
        channel: input.channel,
        skipped: false,
        detail: `webhook returned HTTP ${response.status}`,
        target: url,
      };
    }
    return {
      ok: true,
      channel: input.channel,
      skipped: false,
      detail: `webhook returned HTTP ${response.status}`,
      target: url,
    };
  } catch (error) {
    return {
      ok: false,
      channel: input.channel,
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
      target: url,
    };
  }
}

async function writeLocal(
  input: DeliveryInput,
  env: Record<string, string | undefined>,
): Promise<DeliveryResult> {
  const home = env.KIT_HOME
    ? path.resolve(env.KIT_HOME)
    : path.join(os.homedir(), ".agent-team-kit");
  const dir = path.join(home, "outbox", slug(input.runId) ?? "run");
  const file = path.join(dir, `${slug(input.artifactId) ?? "artifact"}.md`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      `# ${input.title}\n\nRun: ${input.runId}\nArtifact: ${input.artifactId}\n\n---\n\n${input.markdown}\n`,
      "utf8",
    );
    return {
      ok: true,
      channel: "local_file",
      skipped: false,
      detail: "written to the local outbox",
      target: file,
    };
  } catch (error) {
    return {
      ok: false,
      channel: "local_file",
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
      target: file,
    };
  }
}

function renderNotificationHtml(input: NotificationInput): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;color:#18181b">
<h2 style="margin:0 0 8px">${escapeHtml(input.subject)}</h2>
<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:12px;border-radius:6px;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(input.text)}</pre>
<p style="margin-top:16px;color:#a1a1aa;font-size:11px">Sent by Agent Team Kit operations.</p>
</div>`;
}

function renderEmailHtml(input: DeliveryInput): string {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.6;color:#18181b">
<h2 style="margin:0 0 4px">${escapeHtml(input.title)}</h2>
<p style="margin:0 0 16px;color:#71717a;font-size:12px">run ${escapeHtml(input.runId)} · artifact ${escapeHtml(input.artifactId)}</p>
<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:12px;border-radius:6px;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(input.markdown)}</pre>
<p style="margin-top:16px;color:#a1a1aa;font-size:11px">Sent by Agent Team Kit. Delivery is recorded as an artifact.</p>
</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slug(value: string): string | null {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}
