const CRON_FIELD = /^(\*|(\d+)(-\d+)?)(\/\d+)?$/;

export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  return fields.every((field) =>
    field
      .split(",")
      .filter(Boolean)
      .every((part) => CRON_FIELD.test(part)),
  );
}
