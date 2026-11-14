import path from "node:path";
import {
  appendEvent,
  applyDiffToRepo,
  publishIterationArtifact,
  readArtifactText,
  updateRun,
  updateTask,
} from "@kit/iteration";
import { getOpsGate } from "@kit/ops";
import type { initStore } from "@kit/store";
import { type ApplyPendingResult, JobError, type PendingChange } from "./types";

type Store = Awaited<ReturnType<typeof initStore>>;

interface TicketRow {
  ticket_id: string;
  iteration_id: string;
  task_id: string;
  base_sha: string;
  patch_artifact_id: string | null;
  changed_files: unknown;
  risk: string;
  status: string;
  commit_sha: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  domain: string | null;
  goal: string | null;
}

export async function listPendingChanges(
  store: Store,
  jobId?: string,
): Promise<PendingChange[]> {
  const rows = jobId
    ? await store.sql<TicketRow[]>`
        SELECT t.*, ta.domain, ta.goal
        FROM merge_tickets t
        LEFT JOIN iteration_tasks ta
          ON ta.iteration_id = t.iteration_id AND ta.task_id = t.task_id
        WHERE t.status = 'skipped' AND t.iteration_id = ${jobId}
        ORDER BY t.updated_at DESC
      `
    : await store.sql<TicketRow[]>`
        SELECT t.*, ta.domain, ta.goal
        FROM merge_tickets t
        LEFT JOIN iteration_tasks ta
          ON ta.iteration_id = t.iteration_id AND ta.task_id = t.task_id
        WHERE t.status = 'skipped'
        ORDER BY t.updated_at DESC
        LIMIT 100
      `;
  return rows.map(toPendingChange);
}

export async function applyPendingChange(
  store: Store,
  ticketId: string,
  input: { actor: string; note: string; repoRoot: string },
): Promise<ApplyPendingResult> {
  const note = input.note.trim();
  if (!note) {
    throw new JobError("note_required", "a note is required to apply", 400);
  }

  const rows = await store.sql<TicketRow[]>`
    SELECT t.*, ta.domain, ta.goal
    FROM merge_tickets t
    LEFT JOIN iteration_tasks ta
      ON ta.iteration_id = t.iteration_id AND ta.task_id = t.task_id
    WHERE t.ticket_id = ${ticketId}
    LIMIT 1
  `;
  const ticket = rows[0];
  if (!ticket) {
    throw new JobError("not_found", "merge ticket not found", 404);
  }
  if (ticket.status === "applied") {
    throw new JobError("already_applied", "ticket is already applied", 409);
  }
  if (ticket.status !== "skipped") {
    throw new JobError(
      "not_pending",
      `ticket status ${ticket.status} is not eligible for manual apply`,
      409,
    );
  }
  if (!ticket.patch_artifact_id) {
    throw new JobError("missing_diff", "ticket has no diff artifact", 409);
  }
  const risk = parseRisk(ticket.risk);
  const changedFiles = stringArray(ticket.changed_files);

  const runRows = await store.sql<
    Array<{
      workspace_id: string;
      run_mode: "DRY_RUN" | "LIVE";
      goal: string;
      repo_root: string | null;
    }>
  >`
    SELECT workspace_id, run_mode, goal, repo_root FROM iteration_runs
    WHERE iteration_id = ${ticket.iteration_id} LIMIT 1
  `;
  const run = runRows[0];
  if (!run) {
    throw new JobError("run_not_found", "iteration run not found", 404);
  }
  const repoRoot = run.repo_root ? path.resolve(run.repo_root) : input.repoRoot;

  const diff = await readArtifactText(store, ticket.patch_artifact_id);
  if (!diff || diff === "(no diff)" || diff.includes("[truncated at")) {
    throw new JobError("invalid_diff", "diff is empty or truncated", 409);
  }

  const gate = await getOpsGate(store, new Date(), run.workspace_id);
  if (gate.readOnly) {
    throw new JobError(
      "night_mode",
      `apply blocked by ${gate.reason ?? "night mode"}`,
      409,
    );
  }

  const applied = await applyDiffToRepo({
    repoRoot,
    iterationId: ticket.iteration_id,
    taskId: ticket.task_id,
    ticketId,
    diff,
    baseSha: ticket.base_sha,
    changedFiles,
    risk,
    commitMessage: `autonomy: ${ticket.task_id} (approved: ${input.actor})`,
  });

  const now = new Date().toISOString();
  await store.sql`
    UPDATE merge_tickets SET
      status = ${applied.status},
      head_before = ${applied.headBefore || null},
      commit_sha = ${applied.commitSha ?? null},
      error = ${applied.status === "applied" ? null : applied.reason.slice(0, 2000)},
      updated_at = ${now}
    WHERE ticket_id = ${ticketId}
  `;

  await updateTask(store, ticket.iteration_id, ticket.task_id, {
    status: applied.status,
    phase: applied.status,
    applyStatus: applied.status,
    ...(applied.commitSha ? { commit: applied.commitSha } : {}),
    ...(applied.status !== "applied"
      ? { error: applied.reason.slice(0, 2000) }
      : {}),
  });
  await updateRun(store, ticket.iteration_id, {
    phase: applied.status,
    ...(applied.status !== "applied"
      ? { error: applied.reason.slice(0, 2000) }
      : {}),
  });

  const artifactId = await publishIterationArtifact(store, {
    iterationId: ticket.iteration_id,
    workspaceId: run.workspace_id,
    stageId: `${ticket.iteration_id}:${ticket.task_id}:apply:pending`,
    content: JSON.stringify(
      {
        ticketId,
        status: applied.status,
        reason: applied.reason,
        actor: input.actor,
        note,
        risk,
        baseSha: ticket.base_sha,
        headBefore: applied.headBefore,
        baseDrifted: applied.baseDrifted,
        commit: applied.commitSha,
        backupDir: applied.backupDir,
        changedFiles,
      },
      null,
      2,
    ),
    agentId: "policy:autonomy",
    modelId: "none",
    runMode: run.run_mode,
  });

  await updateTask(store, ticket.iteration_id, ticket.task_id, {
    applyArtifactId: artifactId,
  });

  await appendEvent(store, {
    iterationId: ticket.iteration_id,
    taskId: ticket.task_id,
    kind: "apply.finished",
    status: applied.status,
    summary: `pending apply by ${input.actor}: ${applied.reason}`,
    payload: {
      ticketId,
      actor: input.actor,
      note,
      risk,
      commit: applied.commitSha ?? null,
      backupDir: applied.backupDir,
      artifactId,
    },
  });

  return {
    ticketId,
    status: applied.status,
    reason: applied.reason,
    ...(applied.commitSha ? { commit: applied.commitSha } : {}),
    backupDir: applied.backupDir,
    artifactId,
  };
}

function toPendingChange(row: TicketRow): PendingChange {
  return {
    ticketId: row.ticket_id,
    iterationId: row.iteration_id,
    taskId: row.task_id,
    domain: row.domain,
    goal: row.goal,
    risk: parseRisk(row.risk),
    changedFiles: stringArray(row.changed_files),
    baseSha: row.base_sha,
    diffArtifactId: row.patch_artifact_id,
    status: row.status,
    error: row.error,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseRisk(value: string): "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "high";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
