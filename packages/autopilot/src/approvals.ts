import {
  type AutoApprovalPackPolicy,
  type AutoApprovalSignalInput,
  runApprovalMaintenance,
  runAutoApprovalPass,
} from "@kit/manager";
import type { initStore } from "@kit/store";
import type { TriggerPlanePack } from "@kit/trigger";
import { createTemporalClient } from "@kit/workflow";

const WORKSPACE_ID = "default";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface ApprovalTickInput {
  store: Store;
  now: Date;
  packs: readonly TriggerPlanePack[];
  /** Night mode still expires approvals; it only skips policy decisions. */
  readOnly: boolean;
}

export interface ApprovalTickResult {
  approved: string[];
  aborted: string[];
  expired: string[];
  errors: string[];
}

/**
 * Adapts pack configs to the policy layer and drives one approval pass. The
 * decision logic lives in `@kit/manager`; this module only maps config and
 * provides the Temporal signal adapter (96 §5.2).
 */
export async function runApprovalTick(
  input: ApprovalTickInput,
): Promise<ApprovalTickResult> {
  const maintenance = await runApprovalMaintenance(input.store, {
    workspaceId: WORKSPACE_ID,
    now: input.now,
  });
  const result: ApprovalTickResult = {
    approved: [],
    aborted: [],
    expired: maintenance.expired,
    errors: [...maintenance.errors],
  };
  if (input.readOnly) {
    return result;
  }

  const policies = policiesFor(input.packs);
  if (!policies.some((entry) => entry.policy.enabled)) {
    return result;
  }

  const signaler = createApprovalSignaler(input.store);
  try {
    const pass = await runAutoApprovalPass({
      store: input.store,
      workspaceId: WORKSPACE_ID,
      now: input.now,
      packs: policies,
      signal: signaler.signal,
    });
    result.approved = pass.approved;
    result.aborted = pass.aborted;
    result.errors.push(...pass.errors);
  } finally {
    await signaler.close();
  }
  return result;
}

function policiesFor(
  packs: readonly TriggerPlanePack[],
): AutoApprovalPackPolicy[] {
  const policies: AutoApprovalPackPolicy[] = [];
  for (const pack of packs) {
    const auto = pack.config.approval?.autoApprove;
    if (!auto) {
      continue;
    }
    policies.push({
      packDir: pack.dirName,
      workflowIds: pack.loaded.workflows.map((workflow) => workflow.id),
      policy: {
        policyId: `${pack.dirName}:auto-approve`,
        enabled: auto.enabled,
        scope: auto.scope ?? "scheduled",
        maxRisk: auto.maxRisk,
        ...(auto.maxRunCostCny !== undefined
          ? { maxRunCostCny: auto.maxRunCostCny }
          : {}),
        onTimeout: auto.onTimeout,
      },
    });
  }
  return policies;
}

interface ApprovalSignaler {
  signal: (input: AutoApprovalSignalInput) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Local runs poll the decision row, so only Temporal needs a signal. The
 * client is created lazily: a tick with no decisions never opens a connection.
 */
function createApprovalSignaler(store: Store): ApprovalSignaler {
  if (store.driver === "sqlite") {
    return { signal: async () => undefined, close: async () => undefined };
  }

  type TemporalClient = Awaited<
    ReturnType<typeof createTemporalClient>
  >["client"];
  type TemporalConnection = Awaited<
    ReturnType<typeof createTemporalClient>
  >["connection"];
  let client: TemporalClient | undefined;
  let connection: TemporalConnection | undefined;

  return {
    signal: async (input) => {
      if (!client) {
        const created = await createTemporalClient();
        client = created.client;
        connection = created.connection;
      }
      const handle = client.workflow.getHandle(`pack-${input.runId}`);
      await handle.signal("approval", {
        decision: input.decision,
        note: input.rationale,
        requestId: input.requestId,
      });
    },
    close: async () => {
      if (connection) {
        await connection.close();
      }
    },
  };
}
