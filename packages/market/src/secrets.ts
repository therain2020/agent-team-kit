/**
 * Secret scanning for market content (plan 88 §3.5, 50).
 *
 * One pattern set and one scanner for every asset kind so a source and a pack
 * are held to identical secret rules. Manifests and installed files are both
 * scanned before anything is written to disk.
 */

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

export interface SecretFinding {
  file: string;
  line: number;
  label: string;
}

export interface FileText {
  file: string;
  content: string;
}

export function scanSecrets(files: FileText[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
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

/** Render findings for an error message (`file:line (label); ...`). */
export function formatSecretFindings(findings: SecretFinding[]): string {
  return findings
    .map((finding) => `${finding.file}:${finding.line} (${finding.label})`)
    .join("; ");
}
