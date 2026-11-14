const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
];

export function scanSecrets(
  text: string,
  file: string,
  errors: string[],
): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`possible secret in ${file}`);
      return;
    }
  }
}
