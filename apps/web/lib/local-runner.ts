import { newId } from "@kit/core";
import type { PackRunInput } from "@kit/workflow";
import { getStore } from "./store";

// The local runner process claims these rows; the console never executes
// workflows inside the Next server.
export async function submitLocalRun(
  input: PackRunInput,
): Promise<{ requestId: string }> {
  const store = getStore();
  const now = new Date().toISOString();
  const requestId = newId("rrq");
  await store.runRequests.enqueue({
    requestId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    payload: JSON.stringify(input),
    createdAt: now,
    updatedAt: now,
  });
  return { requestId };
}
