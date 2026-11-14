import { appendActivity } from "@kit/activity";
import { newId } from "@kit/core";
import { type DeliveryResult, deliverNotification } from "@kit/delivery";
import type { initStore } from "@kit/store";
import {
  type AlertInput,
  type AlertRecord,
  type AlertStatus,
  type AlertTier,
  DEFAULT_WORKSPACE_ID,
  type NotifyState,
  type OnCallPolicy,
  type OnCallPolicyPatch,
  mergeOnCallPolicy,
  parseAlertTier,
  parseOnCallPolicyPatch,
  safeParseOnCallPolicy,
} from "./models";
import {
  type AlertRouting,
  aggregationWindowMs,
  dedupeKeyFor,
  resolveAlertRouting,
} from "./routing";

export type OpsStore = Awaited<ReturnType<typeof initStore>>;

interface PolicyRow {
  policy: unknown;
}

interface AlertRow {
  alert_id: string;
  workspace_id: string;
  tier: string;
  kind: string;
  status: string;
  dedupe_key: string;
  title: string;
  body: string;
  run_id: string | null;
  stage_id: string | null;
  request_id: string | null;
  source: string | null;
  runbook_url: string | null;
  notify_state: string;
  count: number | string;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  acknowledged_at: string | Date | null;
  acknowledged_by: string | null;
  resolved_at: string | Date | null;
  meta: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AlertListOptions {
  workspaceId?: string;
  status?: AlertStatus;
  tier?: AlertTier;
  limit?: number;
}

export interface RecordAlertResult {
  alert: AlertRecord;
  duplicate: boolean;
}

export interface EmitAlertResult extends RecordAlertResult {
  routing: AlertRouting;
  deliveries: DeliveryResult[];
}

export async function getOpsPolicy(
  store: OpsStore,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<OnCallPolicy> {
  const rows = await store.sql<PolicyRow[]>`
    SELECT policy FROM ops_settings
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;
  return safeParseOnCallPolicy(parseJson(rows[0]?.policy));
}

export async function saveOpsPolicy(
  store: OpsStore,
  workspaceId: string,
  patch: unknown,
): Promise<OnCallPolicy> {
  const current = await getOpsPolicy(store, workspaceId);
  const parsedPatch: OnCallPolicyPatch = parseOnCallPolicyPatch(patch);
  const next = mergeOnCallPolicy(current, parsedPatch);
  const now = new Date().toISOString();
  const encoded = JSON.stringify(next);

  await store.sql`
    INSERT INTO ops_settings (workspace_id, policy, updated_at)
    VALUES (${workspaceId}, ${encoded}, ${now})
    ON CONFLICT (workspace_id) DO UPDATE SET
      policy = ${encoded},
      updated_at = ${now}
  `;

  return next;
}

export async function recordAlert(
  store: OpsStore,
  input: AlertInput,
  options: { now?: Date; policy?: OnCallPolicy } = {},
): Promise<RecordAlertResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const policy = options.policy ?? (await getOpsPolicy(store, workspaceId));
  const dedupeKey = dedupeKeyFor(input);
  const windowMs = aggregationWindowMs(input.tier, policy);

  return await store.sql.begin(async (tx) => {
    if (windowMs > 0) {
      const cutoff = new Date(now.getTime() - windowMs).toISOString();
      const existing = await tx<AlertRow[]>`
        SELECT * FROM ops_alerts
        WHERE workspace_id = ${workspaceId}
          AND dedupe_key = ${dedupeKey}
          AND status <> 'resolved'
          AND last_seen_at >= ${cutoff}
        ORDER BY last_seen_at DESC
        LIMIT 1
      `;
      const row = existing[0];
      if (row) {
        const updatedRows = await tx<AlertRow[]>`
          UPDATE ops_alerts SET
            count = count + 1,
            last_seen_at = ${nowIso},
            updated_at = ${nowIso}
          WHERE alert_id = ${row.alert_id}
          RETURNING *
        `;
        const updated =
          updatedRows[0] ??
          (
            await tx<AlertRow[]>`
              SELECT * FROM ops_alerts WHERE alert_id = ${row.alert_id}
            `
          )[0];
        if (updated) {
          return { alert: mapAlert(updated), duplicate: true };
        }
      }
    }

    const alertId = newId("alt");
    const meta = JSON.stringify(input.meta ?? {});
    const title = truncate(redactText(input.title), 240);
    const body = truncate(redactText(input.body ?? ""), 4000);
    await tx`
      INSERT INTO ops_alerts (
        alert_id, workspace_id, tier, kind, status, dedupe_key, title, body,
        run_id, stage_id, request_id, source, runbook_url, notify_state, count,
        first_seen_at, last_seen_at, meta, created_at, updated_at
      ) VALUES (
        ${alertId}, ${workspaceId}, ${input.tier}, ${input.kind}, 'open',
        ${dedupeKey}, ${title}, ${body}, ${input.runId ?? null},
        ${input.stageId ?? null}, ${input.requestId ?? null},
        ${input.source ?? null}, ${input.runbookUrl ?? null}, 'none', 1,
        ${nowIso}, ${nowIso}, ${meta}, ${nowIso}, ${nowIso}
      )
    `;

    const rows = await tx<AlertRow[]>`
      SELECT * FROM ops_alerts WHERE alert_id = ${alertId} LIMIT 1
    `;
    const inserted = rows[0];
    if (!inserted) {
      throw new Error(`failed to persist alert ${alertId}`);
    }
    return { alert: mapAlert(inserted), duplicate: false };
  });
}

export async function emitAlert(
  store: OpsStore,
  input: AlertInput,
  options: { now?: Date } = {},
): Promise<EmitAlertResult> {
  const now = options.now ?? new Date();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const policy = await getOpsPolicy(store, workspaceId);
  const monthlyCount =
    policy.monthlyBudget === null
      ? undefined
      : await countAlertsThisMonth(store, workspaceId, now);

  const recorded = await recordAlert(store, input, { now, policy });
  const routing = resolveAlertRouting({
    tier: input.tier,
    policy,
    now,
    monthlyCount,
  });

  if (recorded.duplicate) {
    const notifyState: NotifyState = "suppressed_duplicate";
    await updateNotifyState(store, recorded.alert.alertId, notifyState);
    const alert: AlertRecord = { ...recorded.alert, notifyState };
    await audit(store, input, alert, {
      kind: "ops.alert.aggregated",
      routing,
      duplicate: true,
      notifyState,
    });
    return { alert, duplicate: true, routing, deliveries: [] };
  }

  if (routing.suppressed || routing.channels.length === 0) {
    const notifyState = notifyStateForSuppression(routing);
    await updateNotifyState(store, recorded.alert.alertId, notifyState);
    const alert: AlertRecord = { ...recorded.alert, notifyState };
    await audit(store, input, alert, {
      kind: "ops.alert.suppressed",
      routing,
      duplicate: false,
      notifyState,
    });
    return { alert, duplicate: false, routing, deliveries: [] };
  }

  const subject = `[${input.tier}] ${recorded.alert.title}`;
  const text = buildNotificationText(recorded.alert);
  const deliveries = await Promise.all(
    routing.channels.map(async (channel) => {
      try {
        return await deliverNotification({
          channel,
          subject,
          text,
          dryRun: process.env.KIT_OPS_DRY_RUN === "1",
          meta: {
            alertId: recorded.alert.alertId,
            tier: input.tier,
            kind: input.kind,
            runId: input.runId ?? null,
            stageId: input.stageId ?? null,
            requestId: input.requestId ?? null,
            runbookUrl: input.runbookUrl ?? null,
          },
        });
      } catch (error) {
        return {
          ok: false,
          channel,
          skipped: false,
          detail: error instanceof Error ? error.message : String(error),
        } satisfies DeliveryResult;
      }
    }),
  );

  const notifyState: NotifyState = deliveries.some((result) => result.ok)
    ? "sent"
    : "failed";
  await updateNotifyState(store, recorded.alert.alertId, notifyState);
  const alert: AlertRecord = { ...recorded.alert, notifyState };
  await audit(store, input, alert, {
    kind: "ops.alert.emitted",
    routing,
    duplicate: false,
    notifyState,
  });

  return { alert, duplicate: false, routing, deliveries };
}

export async function listAlerts(
  store: OpsStore,
  options: AlertListOptions = {},
): Promise<AlertRecord[]> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = clampInt(options.limit, 1, 500, 100);
  const statusFilter = options.status
    ? store.sql`AND status = ${options.status}`
    : store.sql``;
  const tierFilter = options.tier
    ? store.sql`AND tier = ${options.tier}`
    : store.sql``;

  const rows = await store.sql<AlertRow[]>`
    SELECT * FROM ops_alerts
    WHERE workspace_id = ${workspaceId}
      ${statusFilter}
      ${tierFilter}
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapAlert);
}

export async function ackAlert(
  store: OpsStore,
  alertId: string,
  actor: string,
): Promise<AlertRecord | null> {
  const now = new Date().toISOString();
  await store.sql`
    UPDATE ops_alerts SET
      status = 'acknowledged',
      acknowledged_at = ${now},
      acknowledged_by = ${actor},
      updated_at = ${now}
    WHERE alert_id = ${alertId} AND status = 'open'
  `;
  return await getAlert(store, alertId);
}

export async function resolveAlert(
  store: OpsStore,
  alertId: string,
): Promise<AlertRecord | null> {
  const now = new Date().toISOString();
  await store.sql`
    UPDATE ops_alerts SET
      status = 'resolved',
      resolved_at = ${now},
      updated_at = ${now}
    WHERE alert_id = ${alertId} AND status <> 'resolved'
  `;
  return await getAlert(store, alertId);
}

export async function getAlert(
  store: OpsStore,
  alertId: string,
): Promise<AlertRecord | null> {
  const rows = await store.sql<AlertRow[]>`
    SELECT * FROM ops_alerts WHERE alert_id = ${alertId} LIMIT 1
  `;
  const row = rows[0];
  return row ? mapAlert(row) : null;
}

export async function countAlertsThisMonth(
  store: OpsStore,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  now: Date = new Date(),
): Promise<number> {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const rows = await store.sql<Array<{ total: number | string | null }>>`
    SELECT COUNT(*) AS total FROM ops_alerts
    WHERE workspace_id = ${workspaceId} AND first_seen_at >= ${start}
  `;
  return Number(rows[0]?.total ?? 0);
}

async function updateNotifyState(
  store: OpsStore,
  alertId: string,
  notifyState: NotifyState,
): Promise<void> {
  await store.sql`
    UPDATE ops_alerts SET
      notify_state = ${notifyState},
      updated_at = ${new Date().toISOString()}
    WHERE alert_id = ${alertId}
  `;
}

async function audit(
  store: OpsStore,
  input: AlertInput,
  alert: AlertRecord,
  details: {
    kind: string;
    routing: AlertRouting;
    duplicate: boolean;
    notifyState: NotifyState;
  },
): Promise<void> {
  await appendActivity(store, {
    workspaceId: alert.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: "ops",
    kind: details.kind,
    status: input.tier,
    summary: truncate(alert.title, 200),
    payload: {
      alertId: alert.alertId,
      tier: input.tier,
      kind: input.kind,
      channels: details.routing.channels,
      reason: details.routing.reason,
      duplicate: details.duplicate,
      notifyState: details.notifyState,
    },
  }).catch(() => undefined);
}

function notifyStateForSuppression(routing: AlertRouting): NotifyState {
  switch (routing.reason) {
    case "night_mode":
      return "suppressed_night";
    case "quiet_window":
      return "suppressed_quiet";
    case "monthly_budget":
      return "suppressed_budget";
    default:
      return "none";
  }
}

function buildNotificationText(alert: AlertRecord): string {
  return [
    alert.body,
    alert.runId ? `run: ${alert.runId}` : "",
    alert.stageId ? `stage: ${alert.stageId}` : "",
    alert.requestId ? `request: ${alert.requestId}` : "",
    alert.runbookUrl ? `runbook: ${alert.runbookUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    );
}

function mapAlert(row: AlertRow): AlertRecord {
  return {
    alertId: row.alert_id,
    workspaceId: row.workspace_id,
    tier: parseAlertTier(row.tier) ?? "P3",
    kind: row.kind,
    status: (row.status as AlertStatus) ?? "open",
    dedupeKey: row.dedupe_key,
    title: row.title,
    body: row.body,
    runId: row.run_id,
    stageId: row.stage_id,
    requestId: row.request_id,
    source: row.source,
    runbookUrl: row.runbook_url,
    notifyState: (row.notify_state as NotifyState) ?? "none",
    count: Number(row.count),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    acknowledgedAt: row.acknowledged_at ? toIso(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    meta: parseJsonObject(row.meta),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
