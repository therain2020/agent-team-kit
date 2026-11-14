import type { PreflightLevel, PreflightReport } from "@kit/bootstrap";

const SYMBOLS: Record<PreflightLevel, string> = {
  ok: "✔",
  warn: "⚠",
  fail: "✖",
  info: "ℹ",
};

export function printPreflight(report: PreflightReport): void {
  console.log(`Agent Team Kit self-check (${report.mode} mode)\n`);
  for (const check of report.checks) {
    console.log(
      `${SYMBOLS[check.level]} ${check.label.padEnd(14)} ${check.detail}`,
    );
    if (check.fix && check.level !== "ok") {
      console.log(`  → ${check.fix}`);
    }
  }
}
