import { type LkgVerification, lkgVerification } from "@kit/core";
import { ensureStoreSchema, getStore } from "./store";

export interface LkgView {
  lkgId: string;
  workspaceId: string;
  targetKey: string;
  artifactRefs: { artifactId: string; version: number }[];
  verifiedAt: string;
  verifier: string;
  status: "active" | "superseded";
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
  createdBy: string;
  verification: LkgVerification;
}

/** Active artifact LKG pins with their 7-day verification state (61 §3.2). */
export async function loadLkgOverview(
  workspaceId?: string,
): Promise<LkgView[]> {
  await ensureStoreSchema();
  const records = await getStore().lkg.listActive(workspaceId);
  const now = new Date().toISOString();
  return records.map((record) => ({
    ...record,
    verification: lkgVerification(record, now),
  }));
}
