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

export function findSecret(value: string): string | null {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      return label;
    }
  }
  return null;
}
