import type { WorkshopManifest } from "@kit/core";

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "API key", pattern: /sk-[A-Za-z0-9]{16,}/ },
  { label: "GitHub token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { label: "GitHub token", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/,
  },
];

export interface WorkshopSecretFinding {
  file: string;
  line: number;
  label: string;
}

export interface WorkshopFileContent {
  file: string;
  content: string;
}

export function scanWorkshopSecrets(
  files: WorkshopFileContent[],
): WorkshopSecretFinding[] {
  const findings: WorkshopSecretFinding[] = [];
  for (const { file, content } of files) {
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const hit = SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
      if (hit) {
        findings.push({ file, line: index + 1, label: hit.label });
      }
    }
  }
  return findings;
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
