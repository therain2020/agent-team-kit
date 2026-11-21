import { type GateEvidenceInput, recordGateEvidence } from "@kit/activity";
import { ensureStoreSchema, getStore } from "./store";

/**
 * Best-effort production evidence for the 1.0 support gates (issue #260).
 *
 * Routes call this after the real action succeeded; a failed audit write is
 * logged and never turns a successful operation into an error response. The
 * gate collector reads these rows from `activity_events`; when no row exists
 * the corresponding gate stays a GAP.
 */
export async function recordGateEvidenceSafely(
  input: GateEvidenceInput,
): Promise<void> {
  try {
    await ensureStoreSchema();
    await recordGateEvidence(getStore(), input);
  } catch (error) {
    console.error(
      `[gate-evidence] failed to record ${input.kind}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
