import {
  type DegradedMode,
  enterDegradedMode,
  exitDegradedMode,
  newId,
} from "@kit/core";
import {
  type BoundedEventSpool,
  type SpoolAggregate,
  SpoolBackpressureError,
  type SpoolEnqueueResult,
  type SpoolPriority,
  type SpoolReplayOptions,
  type SpoolReplayReport,
  type SpoolReplayTarget,
} from "@kit/queue";
import type {
  DegradationAuditRecord,
  DegradationStateRecord,
} from "@kit/store";

/**
 * Wires the local event spool into the 61 §2 degradation contract and audit
 * log. The supervisor is intentionally small: it wraps the queue publisher,
 * buffers on failure, and drives enter/exit of workspace `degraded` mode with
 * `event_bus` as the trigger dependency.
 *
 * The state machine itself stays in `@kit/core`; persistence is delegated to
 * the store's degradation store so the same audit trail is visible to the
 * console and CLI.
 */

export interface SpoolPublisher {
  publish(subject: string, data: Uint8Array, messageId?: string): Promise<void>;
}

/** Subset of `@kit/store` DegradationStore used by the supervisor. */
export interface SpoolDegradationSink {
  upsert(record: DegradationStateRecord): Promise<void>;
  markExited(
    scope: DegradationStateRecord["scope"],
    workspaceId: string,
    exitedAt: string,
    exitReason: string,
  ): Promise<boolean>;
  appendAudit(record: DegradationAuditRecord): Promise<void>;
}

export interface EventSpoolSupervisorOptions {
  spool: BoundedEventSpool;
  publisher: SpoolPublisher;
  /** When omitted, buffering still works but no mode/audit rows are written. */
  degradation?: SpoolDegradationSink;
  workspaceId?: string;
  actor?: string;
  now?: () => string;
  onWarning?: (error: Error) => void;
}

export interface SpoolPublishInput {
  eventId: string;
  priority?: SpoolPriority;
}

export type SpoolPublishOutcome =
  | { status: "published" }
  | { status: "buffered"; evicted: string[] }
  | { status: "duplicate" }
  | { status: "dropped"; priority: SpoolPriority; reason: "priority_shed" };

const DEFAULT_WORKSPACE = "default";
const ACTOR = "runtime-spool";

export class EventSpoolSupervisor {
  private readonly spool: BoundedEventSpool;
  private readonly publisher: SpoolPublisher;
  private readonly degradation?: SpoolDegradationSink;
  private readonly workspaceId: string;
  private readonly actor: string;
  private readonly now: () => string;
  private readonly onWarning: (error: Error) => void;
  private mode: DegradedMode | null = null;

  constructor(options: EventSpoolSupervisorOptions) {
    this.spool = options.spool;
    this.publisher = options.publisher;
    this.degradation = options.degradation;
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE;
    this.actor = options.actor ?? ACTOR;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarning =
      options.onWarning ??
      ((error) => {
        console.warn(`[spool] ${error.message}`);
      });
  }

  get buffering(): boolean {
    return this.mode !== null;
  }

  get currentMode(): DegradedMode | null {
    return this.mode;
  }

  /**
   * Publish directly; on any bus failure buffer locally instead and enter
   * degraded mode once. `SpoolBackpressureError` propagates so the caller can
   * shed or retry upstream — the spool never grows without bound.
   */
  async publish(
    subject: string,
    data: Uint8Array,
    input: SpoolPublishInput,
  ): Promise<SpoolPublishOutcome> {
    try {
      await this.publisher.publish(subject, data, input.eventId);
      return { status: "published" };
    } catch (error) {
      await this.enterBufferMode(error);
      const result = await this.spool.enqueue({
        eventId: input.eventId,
        subject,
        data,
        priority: input.priority,
        workspaceId: this.workspaceId,
      });
      return this.toOutcome(result);
    }
  }

  /**
   * Replay the backlog. LIVE: apply, dedupe by event_id, then leave degraded
   * mode with an exit audit once the backlog is fully drained. Non-LIVE:
   * route through the sandbox executor and leave mode and backlog untouched.
   */
  async replay(
    target: SpoolReplayTarget,
    options: SpoolReplayOptions,
  ): Promise<SpoolReplayReport> {
    const report = await this.spool.replay(target, options);
    if (
      options.runMode === "LIVE" &&
      report.failed.length === 0 &&
      report.remaining === 0
    ) {
      await this.exitBufferMode(report);
    }
    return report;
  }

  /** Aggregate snapshot used by console diagnostics and the drill script. */
  async aggregate(): Promise<SpoolAggregate> {
    return this.spool.aggregate();
  }

  private toOutcome(result: SpoolEnqueueResult): SpoolPublishOutcome {
    switch (result.status) {
      case "buffered":
        return { status: "buffered", evicted: result.evicted };
      case "duplicate":
        return { status: "duplicate" };
      case "dropped":
        return {
          status: "dropped",
          priority: result.priority,
          reason: result.reason,
        };
    }
  }

  private async enterBufferMode(cause: unknown): Promise<void> {
    if (this.mode) {
      return;
    }

    const reason = cause instanceof Error ? cause.message : String(cause);
    let aggregate: SpoolAggregate | null = null;
    try {
      aggregate = await this.spool.aggregate();
    } catch (error) {
      this.warn(error);
    }

    let mode: DegradedMode;
    try {
      mode = enterDegradedMode({
        scope: "workspace",
        workspaceId: this.workspaceId,
        kind: "degraded",
        triggers: [
          {
            dependencyId: "event_bus",
            reason: `event bus unavailable: ${reason}`,
          },
        ],
        behavior:
          "Event bus outage: buffer events locally, keep new work queued and replay by event_id on recovery.",
        actor: this.actor,
        now: this.now(),
      });
    } catch (error) {
      // Without a valid mode we still buffer; availability wins, but the
      // contract violation is surfaced to the caller.
      this.warn(error);
      this.mode = null;
      return;
    }

    this.mode = mode;

    if (!this.degradation) {
      return;
    }

    try {
      await this.degradation.upsert({
        ...mode,
        exitedAt: null,
        exitReason: null,
      });
      await this.degradation.appendAudit({
        auditId: newId("daud"),
        occurredAt: mode.enteredAt,
        actor: this.actor,
        action: "enter",
        scope: mode.scope,
        workspaceId: this.workspaceId,
        modeId: mode.modeId,
        detail: {
          dependencyId: "event_bus",
          reason,
          aggregate,
        },
      });
    } catch (error) {
      this.warn(error);
    }
  }

  private async exitBufferMode(report: SpoolReplayReport): Promise<void> {
    const mode = this.mode;
    if (!mode) {
      return;
    }

    const exited = exitDegradedMode(mode, {
      actor: this.actor,
      reason: "event bus recovered; spool replayed",
      now: this.now(),
      qualityRecheck: { pass: true },
    });
    if (!exited.ok) {
      this.warn(
        new Error(
          `refusing to exit degraded mode: ${exited.reasons.join("; ")}`,
        ),
      );
      return;
    }

    this.mode = null;
    if (!this.degradation) {
      return;
    }

    const exitedAt = exited.mode.exitedAt ?? this.now();
    try {
      await this.degradation.markExited(
        mode.scope,
        this.workspaceId,
        exitedAt,
        "event bus recovered; spool replayed",
      );
      await this.degradation.appendAudit({
        auditId: newId("daud"),
        occurredAt: exitedAt,
        actor: this.actor,
        action: "exit",
        scope: mode.scope,
        workspaceId: this.workspaceId,
        modeId: mode.modeId,
        detail: {
          dependencyId: "event_bus",
          delivered: report.delivered,
          duplicates: report.duplicates,
          remaining: report.remaining,
          qualityRecheck: true,
        },
      });
    } catch (error) {
      this.warn(error);
    }
  }

  private warn(error: unknown): void {
    this.onWarning(error instanceof Error ? error : new Error(String(error)));
  }
}

export { SpoolBackpressureError };
