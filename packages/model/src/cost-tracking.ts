import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ToolCompletionRequest,
  ToolCompletionResponse,
} from "./index";
import {
  type PriceTable,
  type ResolvedModelPrice,
  computeCostMicro,
  loadPriceTable,
  resolveModelPrice,
} from "./prices";

/**
 * What a charged call belongs to. Run-scoped calls are the default; compose,
 * evolution and manager calls happen outside a run and carry the id of their
 * aggregate object instead (60 §3.3).
 */
export type CostScopeKind = "run" | "job" | "evolution" | "manager";

export interface CostScope {
  kind: CostScopeKind;
  id: string;
}

/**
 * One charged call, ready to append to the cost ledger. `unitPrice*Micro` are
 * micro-CNY per 1,000 tokens stamped from the price table version that priced
 * the call, so the record stays reproducible after a repricing.
 */
export interface CostCallRecord {
  callId: string;
  workspaceId: string;
  /**
   * Correlation key. It is the real run id for run-scoped calls and the
   * namespaced `kind:id` scope key otherwise, so the legacy column stays
   * unique without pretending a non-run call belongs to a run.
   */
  runId: string;
  scopeKind: CostScopeKind;
  scopeId: string;
  jobId: string | null;
  changeId: string | null;
  managerSessionId: string | null;
  stageId: string | null;
  agentId: string | null;
  /** `model` for a completion, `tool:<name>` for an executed tool call. */
  source: string;
  artifactId: string | null;
  modelId: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  unitPriceInMicro: number;
  unitPriceOutMicro: number;
  priceVersion: string;
  currency: "CNY";
  costCnyMicro: number;
  tracked: boolean;
  untrackedReason: string | null;
  ts: string;
}

export interface CostLedgerSink {
  record(record: CostCallRecord): Promise<unknown> | unknown;
}

export interface CostCallContext {
  workspaceId: string;
  /** Set for run-scoped calls; absent for job/evolution/manager calls. */
  runId?: string | null;
  scopeKind?: CostScopeKind;
  /** Explicit aggregate id; defaults to runId or the matching aggregate field. */
  scopeId?: string | null;
  jobId?: string | null;
  changeId?: string | null;
  managerSessionId?: string | null;
  stageId?: string | null;
  agentId?: string | null;
  /** Overrides the `model` source label, e.g. `judge` or `revision`. */
  source?: string;
}

/**
 * Resolve the attribution scope of a context exactly once. A call without any
 * run or aggregate key is a wiring bug, not a billable event, so it throws.
 */
export function resolveCostScope(
  context: Pick<
    CostCallContext,
    | "workspaceId"
    | "runId"
    | "scopeKind"
    | "scopeId"
    | "jobId"
    | "changeId"
    | "managerSessionId"
  >,
): CostScope & { runId: string } {
  const runId = trimmed(context.runId);
  const jobId = trimmed(context.jobId);
  const changeId = trimmed(context.changeId);
  const managerSessionId = trimmed(context.managerSessionId);
  const kind =
    context.scopeKind ??
    (runId
      ? "run"
      : jobId
        ? "job"
        : changeId
          ? "evolution"
          : managerSessionId
            ? "manager"
            : null);
  if (!kind) {
    throw new Error(
      "cost attribution requires a runId, scopeKind or aggregate id",
    );
  }
  const id =
    trimmed(context.scopeId) ?? runId ?? jobId ?? changeId ?? managerSessionId;
  if (!id) {
    throw new Error(`cost attribution scope ${kind} requires an id`);
  }
  return { kind, id, runId: runId ?? `${kind}:${id}` };
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export interface CostTrackingOptions {
  context: CostCallContext;
  sink: CostLedgerSink;
  priceTable?: PriceTable;
  now?: () => Date;
  /** Prefix for generated call ids; ids must be unique per charged call. */
  callIdPrefix?: string;
  /** Ledger failures are logged, never fail a call already paid for. */
  onError?: (error: unknown) => void;
}

interface ResolvedUsage {
  price: ResolvedModelPrice;
  tokensIn: number;
  tokensOut: number;
  costCnyMicro: number;
}

function resolveUsage(
  usage: ModelUsage,
  requestedModel: string,
  table: PriceTable,
  now: Date,
): ResolvedUsage {
  const tokensIn = Math.max(0, Math.trunc(usage.inputTokens));
  const tokensOut = Math.max(0, Math.trunc(usage.outputTokens));
  const modelId = usage.modelId ?? requestedModel;
  // Gateways already resolved the price; re-resolving here would drop a stub
  // marker or a caller-injected price. Only fill in when the gateway left it
  // blank (custom gateway implementations).
  if (usage.priceVersion && usage.tracked !== undefined) {
    const inputPer1kMicro = Math.round((usage.unitPriceIn ?? 0) * 1_000_000);
    const outputPer1kMicro = Math.round((usage.unitPriceOut ?? 0) * 1_000_000);
    return {
      price: {
        tracked: usage.tracked,
        modelId,
        provider: usage.provider ?? "unknown",
        currency: "CNY",
        inputPer1k: usage.unitPriceIn ?? 0,
        outputPer1k: usage.unitPriceOut ?? 0,
        inputPer1kMicro,
        outputPer1kMicro,
        priceVersion: usage.priceVersion,
        effectiveAt: now.toISOString(),
        untrackedReason: usage.untrackedReason ?? null,
      },
      tokensIn,
      tokensOut,
      costCnyMicro: computeCostMicro(
        { inputPer1kMicro, outputPer1kMicro },
        tokensIn,
        tokensOut,
      ),
    };
  }
  const price = resolveModelPrice(table, modelId, now);
  return {
    price,
    tokensIn,
    tokensOut,
    costCnyMicro: computeCostMicro(price, tokensIn, tokensOut),
  };
}

/**
 * Decorates any {@link ModelGateway} so every completion is charged to the
 * ledger at the single call point. Callers supply only attribution context;
 * pricing and idempotency stay here. Tool execution is charged by the executor
 * (engine tool loop), not here, because only executed calls should be billed.
 */
export class CostTrackingGateway implements ModelGateway {
  private callIndex = 0;
  private readonly scope: CostScope & { runId: string };

  constructor(
    private readonly inner: ModelGateway,
    private readonly options: CostTrackingOptions,
  ) {
    // Fail at wiring time when attribution is missing, not after a paid call.
    this.scope = resolveCostScope(options.context);
  }

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.inner.complete(request, signal);
    await this.chargeResponse(request.model, response.usage);
    return response;
  }

  async completeWithTools(
    request: ToolCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ToolCompletionResponse> {
    const response = await this.inner.completeWithTools(request, signal);
    await this.chargeResponse(request.model, response.usage);
    return response;
  }

  private async chargeResponse(
    requestedModel: string,
    usage: ModelUsage,
  ): Promise<void> {
    const now = this.options.now?.() ?? new Date();
    const table = this.options.priceTable ?? loadPriceTable();
    const { price, tokensIn, tokensOut, costCnyMicro } = resolveUsage(
      usage,
      requestedModel,
      table,
      now,
    );
    const callId = `${this.options.callIdPrefix ?? this.scope.runId}:call-${this.callIndex++}`;
    const record: CostCallRecord = {
      callId,
      workspaceId: this.options.context.workspaceId,
      runId: this.scope.runId,
      scopeKind: this.scope.kind,
      scopeId: this.scope.id,
      jobId: trimmed(this.options.context.jobId),
      changeId: trimmed(this.options.context.changeId),
      managerSessionId: trimmed(this.options.context.managerSessionId),
      stageId: this.options.context.stageId ?? null,
      agentId: this.options.context.agentId ?? null,
      source: this.options.context.source ?? "model",
      artifactId: null,
      modelId: price.modelId,
      provider: price.provider,
      tokensIn,
      tokensOut,
      unitPriceInMicro: price.inputPer1kMicro,
      unitPriceOutMicro: price.outputPer1kMicro,
      priceVersion: price.priceVersion,
      currency: "CNY",
      costCnyMicro,
      tracked: price.tracked,
      untrackedReason: price.untrackedReason,
      ts: now.toISOString(),
    };
    try {
      await this.options.sink.record(record);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
