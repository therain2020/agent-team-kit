import type { WorkshopManifest } from "@kit/core";
import { type FileText, type SecretFinding, scanSecrets } from "@kit/market";

/**
 * Workshop secret scanning and permission summary. The scanner itself lives in
 * the single market kernel (`@kit/market`) so sources and packs share one
 * pattern set; the permission summary stays workshop-specific.
 */

export type WorkshopSecretFinding = SecretFinding;

export type WorkshopFileContent = FileText;

export function scanWorkshopSecrets(
  files: WorkshopFileContent[],
): WorkshopSecretFinding[] {
  return scanSecrets(files);
}

export type WorkshopPermissionRisk = "low" | "medium" | "high";

export interface WorkshopPermissionEntry {
  id: string;
  label: string;
  risk: WorkshopPermissionRisk;
}

export interface WorkshopPermissionSummary {
  entries: WorkshopPermissionEntry[];
  highRisk: WorkshopPermissionEntry[];
}

export function summarizeWorkshopPermissions(
  manifest: WorkshopManifest,
): WorkshopPermissionSummary {
  const entries: WorkshopPermissionEntry[] = [];
  if (manifest.permissions.network) {
    entries.push({
      id: "network",
      label: "outbound network access",
      risk: "high",
    });
  }
  if (manifest.permissions.filesystem !== "none") {
    const mode = manifest.permissions.filesystem;
    entries.push({
      id: `filesystem:${mode}`,
      label: `filesystem ${mode}`,
      risk: mode === "workspace" ? "medium" : "low",
    });
  }
  if (manifest.permissions.code) {
    entries.push({ id: "code", label: "executable code", risk: "high" });
  }
  return {
    entries,
    highRisk: entries.filter((entry) => entry.risk === "high"),
  };
}
