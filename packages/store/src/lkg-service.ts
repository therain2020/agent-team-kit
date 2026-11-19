import {
  type LastKnownGood,
  type LkgVerification,
  type RegisterLastKnownGoodInput,
  lkgVerification,
  registerLastKnownGood,
  selectLastKnownGood,
} from "@kit/core";
import { type OpLogStore, appendOp } from "./op-log";
import type { LastKnownGoodStore } from "./repositories";

export interface RegisterLkgResult {
  record: LastKnownGood;
  previous: LastKnownGood[];
  changed: boolean;
  /** False when the op-log append failed; the switch itself still applied. */
  audited: boolean;
}

export interface LkgResolution {
  lkg: LastKnownGood | null;
  verification: LkgVerification | null;
}

/**
 * Single writer for artifact-level LKG switches. Every register/switch lands
 * in the op log so the switch can be reviewed after the fact (61 §5).
 */
export class LastKnownGoodService {
  constructor(
    private readonly store: LastKnownGoodStore,
    private readonly ops?: OpLogStore,
  ) {}

  async register(
    input: RegisterLastKnownGoodInput,
  ): Promise<RegisterLkgResult> {
    const record = registerLastKnownGood(input);
    const result = await this.store.switch(record);

    let audited = false;
    if (this.ops) {
      try {
        await appendOp(this.ops, {
          workspaceId: result.record.workspaceId,
          entityKind: "last_known_good",
          entityId: result.record.lkgId,
          op: result.previous.length > 0 ? "lkg.switch" : "lkg.register",
          actor: result.record.createdBy,
          origin: "system",
          idempotencyKey: `lkg.switch:${result.record.lkgId}`,
          payload: {
            targetKey: result.record.targetKey,
            artifactRefs: result.record.artifactRefs,
            verifiedAt: result.record.verifiedAt,
            verifier: result.record.verifier,
            previous: result.previous.map((previous) => previous.lkgId),
          },
        });
        audited = true;
      } catch (error) {
        // The switch is already durable; surface the audit gap in the result
        // instead of pretending the switch did not happen.
        console.error(
          `[lkg] audit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { ...result, audited };
  }

  async resolve(input: {
    workspaceId: string;
    targetKey?: string;
    artifactId?: string;
    now?: string;
  }): Promise<LkgResolution> {
    const active = await this.store.listActive(input.workspaceId);
    const candidates = input.targetKey
      ? active.filter((record) => record.targetKey === input.targetKey)
      : active;
    const lkg = selectLastKnownGood(candidates, input.artifactId);
    return {
      lkg,
      verification: lkg ? lkgVerification(lkg, input.now) : null,
    };
  }

  async history(
    workspaceId: string,
    targetKey: string,
    limit?: number,
  ): Promise<LastKnownGood[]> {
    return this.store.history(workspaceId, targetKey, limit);
  }
}
