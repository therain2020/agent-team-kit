import type { ReactionRule } from "@kit/core";
import {
  type InformationEventRecord,
  appendOp,
  type initStore,
} from "@kit/store";
import type { FireTriggerDeps } from "./dispatch";
import {
  type ReactionDeps,
  type ReactionOutcome,
  evaluateReactionRules,
  reactToInformationEvent,
} from "./reaction";

/**
 * Automatic information → ReactionRule dispatch (98 §3.3, §5.2 G1, D-70).
 *
 * G1 requires the information loop to run without an operator creating tasks.
 * This launcher is the missing trigger edge: it sweeps persisted
 * information events that appeared after its cursor and feeds each one to
 * {@link reactToInformationEvent}, which already owns rule matching, the
 * `fireTrigger` gate order, `eventId:ruleId` dedupe, budgets and the audit
 * trail. No second dispatch path and no second job write are introduced.
 *
 * Reliability:
 * - the cursor is a `created_at` watermark with a small overlap, so an event
 *   committed while a pass is running is caught on the next pass;
 * - the TriggerRun dedupe key makes replays (restart, manual `kit reaction
 *   run`, `POST /api/reactions/run`) return the existing job instead of a
 *   second one;
 * - failed launches are retried with exponential backoff and each attempt is
 *   audited as a `reaction.retry-scheduled` / `reaction.retry-exhausted` op.
 *
 * Switch: `KIT_REACTION_AUTO_DISPATCH` (default on). Setting it to
 * `0`/`false`/`off`/`no` disables automatic dispatch without touching any
 * other path; manual replay keeps working. The default is deliberately "on"
 * because the 1.0 main gate forbids requiring an operator to start reactions.
 */

type Store = Awaited<ReturnType<typeof initStore>>;

const DEFAULT_LOOKBACK_MS = 3_600_000;
const DEFAULT_OVERLAP_MS = 2_000;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

/** The switch default is ON: reactions must not need an operator to run. */
export function isReactionAutoDispatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.KIT_REACTION_AUTO_DISPATCH?.trim().toLowerCase();
  if (!value) {
    return true;
  }
  return !DISABLED_VALUES.has(value);
}

export interface AutoDispatchRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface InformationAutoDispatcherOptions
  extends Omit<FireTriggerDeps, "now" | "store"> {
  /** Clock seam; one pass evaluates every rule under the same timestamp. */
  clock?: () => Date;
  /** Rule source override; defaults to the store's current rules per pass. */
  rules?: readonly ReactionRule[] | (() => Promise<readonly ReactionRule[]>);
  /** First-pass scan window when the dispatcher starts. Default 1 hour. */
  lookbackMs?: number;
  /** Hard event cap per pass (bounded information storms). Default 200. */
  maxEventsPerPass?: number;
  /** Re-read overlap that avoids missing events committed mid-pass. */
  overlapMs?: number;
  /** Backoff for failed launches. Default 30s doubling, capped at 15 min. */
  retry?: AutoDispatchRetryPolicy;
  /** Override for the `reactions.jsonl` signal file. */
  reactionsPath?: string;
}

export type AutoDispatchStatus = "dispatched" | "idle" | "busy" | "stopped";

export interface AutoDispatchPassSummary {
  workspaceId: string;
  status: AutoDispatchStatus;
  startedAt: string;
  finishedAt: string;
  /** Cursor the pass started from. */
  since: string;
  /** Cursor persisted for the next pass. */
  cursor: string;
  events: number;
  retried: number;
  fired: number;
  existing: number;
  skipped: number;
  failed: number;
  deferred: number;
  outcomes: ReactionOutcome[];
  errors: string[];
}

export interface AutoDispatchLoop {
  runOnce(): Promise<AutoDispatchPassSummary>;
  stop(): void;
}

interface RetryState {
  eventId: string;
  ruleId: string;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

/**
 * Sweeps new information events into the existing reaction dispatcher.
 *
 * One instance owns one cursor per workspace. `runOnce` never overlaps itself,
 * so wiring it to both the collection pass and a timer cannot double-dispatch.
 */
export class InformationAutoDispatcher {
  private readonly clock: () => Date;
  private readonly workspaceId: string;
  private readonly retries = new Map<string, RetryState>();
  private cursor: string;
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly options: InformationAutoDispatcherOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.workspaceId = options.workspaceId ?? "default";
    const lookbackMs = Math.max(
      0,
      options.lookbackMs ??
        positiveInt(this.env.KIT_REACTION_DISPATCH_LOOKBACK_MS) ??
        DEFAULT_LOOKBACK_MS,
    );
    this.cursor = new Date(this.clock().getTime() - lookbackMs).toISOString();
  }

  /** The cursor the next pass will start from. */
  get since(): string {
    return this.cursor;
  }

  /** Pending retry count, exposed for the runtime log line and tests. */
  get pendingRetries(): number {
    return this.retries.size;
  }

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<AutoDispatchPassSummary> {
    const now = this.clock();
    const startedAt = now.toISOString();
    const since = this.cursor;
    const empty = this.summary("idle", since, startedAt, startedAt);
    if (this.stopped) {
      return { ...empty, status: "stopped" };
    }
    if (this.running) {
      return { ...empty, status: "busy" };
    }
    this.running = true;

    const outcomes: ReactionOutcome[] = [];
    const errors: string[] = [];
    let events = 0;
    let retried = 0;

    try {
      const rules = await this.loadRules();
      const batch = await this.store.information.listEvents({
        workspaceId: this.workspaceId,
        createdAfter: since,
        order: "asc",
        limit: this.maxEventsPerPass,
      });
      events = batch.length;

      for (const event of batch) {
        try {
          const outcome = await this.dispatch(event, rules, now);
          outcomes.push(outcome);
          await this.trackRetries(event.eventId, outcome, now);
        } catch (error) {
          const message = errorText(error);
          errors.push(`${event.eventId}: ${message}`);
          await this.audit(event.eventId, "*", "reaction.dispatch-error", {
            eventId: event.eventId,
            reason: message,
          });
          // A thrown dispatch (store hiccup, malformed pack) is a failure too:
          // schedule the matching rules so backoff can recover the event.
          for (const candidate of evaluateReactionRules(rules, event)) {
            if (candidate.decision === "pending") {
              await this.scheduleRetry(
                event.eventId,
                candidate.ruleId,
                message,
                now,
              );
            }
          }
        }
      }

      this.advanceCursor(batch, now);

      const drained = await this.drainRetries(rules, now);
      outcomes.push(...drained.outcomes);
      errors.push(...drained.errors);
      retried = drained.retried;

      return this.withCounts(
        this.summary(
          firedOrSkipped(outcomes) ? "dispatched" : "idle",
          since,
          startedAt,
          this.clock().toISOString(),
        ),
        outcomes,
        events,
        retried,
        errors,
      );
    } catch (error) {
      errors.push(errorText(error));
      return this.withCounts(
        this.summary("idle", since, startedAt, this.clock().toISOString()),
        outcomes,
        events,
        retried,
        errors,
      );
    } finally {
      this.running = false;
    }
  }

  private async dispatch(
    event: InformationEventRecord,
    rules: readonly ReactionRule[],
    now: Date,
  ): Promise<ReactionOutcome> {
    return reactToInformationEvent(event, this.reactionDeps(rules, now));
  }

  private async drainRetries(
    rules: readonly ReactionRule[],
    now: Date,
  ): Promise<{
    outcomes: ReactionOutcome[];
    errors: string[];
    retried: number;
  }> {
    const due = [...this.retries.values()]
      .filter((state) => state.nextAt <= now.getTime())
      .sort((left, right) => left.nextAt - right.nextAt);
    const outcomes: ReactionOutcome[] = [];
    const errors: string[] = [];
    let retried = 0;

    for (const state of due) {
      const key = retryKey(state.eventId, state.ruleId);
      const rule = rules.find(
        (item) => item.ruleId === state.ruleId && item.enabled,
      );
      if (!rule) {
        this.retries.delete(key);
        continue;
      }
      const event = await this.store.information.getEvent(
        this.workspaceId,
        state.eventId,
      );
      if (!event) {
        this.retries.delete(key);
        continue;
      }
      retried += 1;
      try {
        const outcome = await reactToInformationEvent(
          event,
          this.reactionDeps([rule], now),
        );
        outcomes.push(outcome);
        await this.trackRetries(event.eventId, outcome, now);
      } catch (error) {
        const message = errorText(error);
        errors.push(`${state.eventId}/${state.ruleId}: ${message}`);
        // The attempt was consumed; schedule the next backoff step.
        await this.scheduleRetry(state.eventId, state.ruleId, message, now);
      }
    }

    return { outcomes, errors, retried };
  }

  private async trackRetries(
    eventId: string,
    outcome: ReactionOutcome,
    now: Date,
  ): Promise<void> {
    for (const candidate of outcome.candidates) {
      if (candidate.decision === "failed") {
        await this.scheduleRetry(
          eventId,
          candidate.ruleId,
          candidate.reason ?? "dispatch failed",
          now,
        );
        continue;
      }
      // Any other terminal decision resolves the rule for this event.
      this.retries.delete(retryKey(eventId, candidate.ruleId));
    }
  }

  private async scheduleRetry(
    eventId: string,
    ruleId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    const key = retryKey(eventId, ruleId);
    const attempts = (this.retries.get(key)?.attempts ?? 0) + 1;
    const policy = this.retryPolicy();
    if (attempts >= policy.maxAttempts) {
      this.retries.delete(key);
      await this.audit(eventId, ruleId, "reaction.retry-exhausted", {
        eventId,
        ruleId,
        attempt: attempts,
        reason,
      });
      return;
    }
    const delayMs = Math.min(
      policy.baseDelayMs * 2 ** (attempts - 1),
      policy.maxDelayMs,
    );
    const nextAt = now.getTime() + delayMs;
    this.retries.set(key, {
      eventId,
      ruleId,
      attempts,
      nextAt,
      lastError: reason,
    });
    await this.audit(
      eventId,
      ruleId,
      "reaction.retry-scheduled",
      {
        eventId,
        ruleId,
        attempt: attempts,
        delayMs,
        nextAttemptAt: new Date(nextAt).toISOString(),
        reason,
      },
      `reaction:${eventId}:${ruleId}:retry:${attempts}`,
    );
  }

  private reactionDeps(
    rules: readonly ReactionRule[],
    now: Date,
  ): ReactionDeps {
    return {
      ...this.options,
      store: this.store,
      now,
      rules,
      ...(this.options.reactionsPath !== undefined
        ? { reactionsPath: this.options.reactionsPath }
        : {}),
    };
  }

  private async loadRules(): Promise<readonly ReactionRule[]> {
    const source = this.options.rules;
    if (typeof source === "function") {
      return source();
    }
    if (source) {
      return source;
    }
    return this.store.reactionRules.listCurrent(this.workspaceId, {
      enabledOnly: true,
    });
  }

  private get maxEventsPerPass(): number {
    const configured =
      this.options.maxEventsPerPass ??
      positiveInt(this.env.KIT_REACTION_DISPATCH_MAX_EVENTS) ??
      DEFAULT_MAX_EVENTS;
    return Math.max(1, Math.min(Math.trunc(configured), 500));
  }

  private get overlapMs(): number {
    return Math.max(0, this.options.overlapMs ?? DEFAULT_OVERLAP_MS);
  }

  private get env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private retryPolicy(): Required<AutoDispatchRetryPolicy> {
    const base = Math.max(
      1,
      this.options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    );
    const max = Math.max(
      base,
      this.options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_MS,
    );
    return {
      maxAttempts: Math.max(
        1,
        this.options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      ),
      baseDelayMs: base,
      maxDelayMs: max,
    };
  }

  /**
   * Move the watermark forward. A full batch keeps the cursor at the last
   * event (minus 1 ms so same-millisecond siblings are re-read); an unfilled
   * batch jumps to `now - overlap`, which still re-reads the pass boundary.
   */
  private advanceCursor(
    batch: readonly InformationEventRecord[],
    now: Date,
  ): void {
    let target: string;
    if (batch.length >= this.maxEventsPerPass) {
      const last = batch[batch.length - 1];
      target = last
        ? new Date(Date.parse(last.createdAt) - 1).toISOString()
        : new Date(now.getTime() - this.overlapMs).toISOString();
    } else {
      target = new Date(now.getTime() - this.overlapMs).toISOString();
    }
    if (target > this.cursor) {
      this.cursor = target;
    }
  }

  private summary(
    status: AutoDispatchStatus,
    since: string,
    startedAt: string,
    finishedAt: string,
  ): AutoDispatchPassSummary {
    return {
      workspaceId: this.workspaceId,
      status,
      startedAt,
      finishedAt,
      since,
      cursor: this.cursor,
      events: 0,
      retried: 0,
      fired: 0,
      existing: 0,
      skipped: 0,
      failed: 0,
      deferred: this.retries.size,
      outcomes: [],
      errors: [],
    };
  }

  private withCounts(
    summary: AutoDispatchPassSummary,
    outcomes: readonly ReactionOutcome[],
    events: number,
    retried: number,
    errors: readonly string[],
  ): AutoDispatchPassSummary {
    return {
      ...summary,
      cursor: this.cursor,
      events,
      retried,
      fired: sum(outcomes, (item) => item.fired),
      existing: sum(outcomes, (item) => item.existing),
      skipped: sum(outcomes, (item) => item.skipped),
      failed: sum(outcomes, (item) => item.failed),
      deferred: this.retries.size,
      outcomes: [...outcomes],
      errors: [...errors],
    };
  }

  private async audit(
    eventId: string,
    ruleId: string,
    op: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<void> {
    await appendOp(this.store, {
      workspaceId: this.workspaceId,
      entityKind: "reaction",
      entityId: `${eventId}:${ruleId}`,
      op,
      actor: "runtime:reaction-dispatch",
      origin: "system",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      payload,
      createdAt: this.clock().toISOString(),
    }).catch(() => undefined);
  }
}

export interface AutoDispatchLoopOptions
  extends InformationAutoDispatcherOptions {
  /** Sweep interval in milliseconds. Default 60s. */
  intervalMs?: number;
  /** Run a pass immediately on start. Default true. */
  runImmediately?: boolean;
  onPass?: (summary: AutoDispatchPassSummary) => void;
  onError?: (error: unknown) => void;
}

/**
 * Start the automatic dispatcher unless `KIT_REACTION_AUTO_DISPATCH` turns it
 * off. Returns `null` when disabled so the caller can log the decision.
 */
export function startInformationAutoDispatch(
  store: Store,
  options: AutoDispatchLoopOptions,
): AutoDispatchLoop | null {
  const env = options.env ?? process.env;
  if (!isReactionAutoDispatchEnabled(env)) {
    return null;
  }
  const dispatcher = new InformationAutoDispatcher(store, options);
  const intervalMs = Math.max(
    1000,
    Math.trunc(
      options.intervalMs ??
        positiveInt(env.KIT_REACTION_DISPATCH_INTERVAL_MS) ??
        DEFAULT_INTERVAL_MS,
    ),
  );
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      const summary = await dispatcher.runOnce();
      options.onPass?.(summary);
    } catch (error) {
      options.onError?.(error);
    }
  };

  if (options.runImmediately !== false) {
    void tick();
  }
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    runOnce: () => dispatcher.runOnce(),
    stop() {
      stopped = true;
      dispatcher.stop();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function retryKey(eventId: string, ruleId: string): string {
  return `${eventId}|${ruleId}`;
}

function firedOrSkipped(outcomes: readonly ReactionOutcome[]): boolean {
  return outcomes.some(
    (item) => item.fired > 0 || item.existing > 0 || item.skipped > 0,
  );
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
