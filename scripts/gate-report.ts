/**
 * 1.0 gate evidence report (issue #135, plan 98 §5.1/§5.2, 85 §5.2).
 *
 * Collects local store/audit/signals evidence and prints a rerunnable report.
 * Missing evidence is reported as GAP; the report never claims 1.0.
 *
 * Run: `bun run gates:report` (add `--json`, `--strict`, `--out <file>`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CollectOptions,
  collectEvidence,
  defaultHome,
} from "./gate-report/collect";
import {
  DEFAULT_WINDOW_DAYS,
  type GateReport,
  buildGateReport,
} from "./gate-report/model";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  const days = numberArg(argv, "--days") ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    console.error("--days must be an integer between 1 and 90");
    return 2;
  }
  const now = argValue(argv, "--now") ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) {
    console.error(`--now is not a valid ISO timestamp: ${now}`);
    return 2;
  }

  const options: CollectOptions = {
    home: path.resolve(argValue(argv, "--home") ?? defaultHome()),
    repoRoot: path.resolve(argValue(argv, "--repo") ?? repoRoot),
    now,
    days,
  };
  assignPath(options, "dbPath", argValue(argv, "--db"));
  assignPath(options, "packsRoot", argValue(argv, "--packs"));
  assignPath(options, "signalsRoot", argValue(argv, "--signals"));
  assignPath(options, "sourcesRoot", argValue(argv, "--sources"));
  assignPath(options, "reactionsPath", argValue(argv, "--reactions"));
  assignPath(
    options,
    "supervisorStatePath",
    argValue(argv, "--supervisor-state"),
  );
  assignPath(options, "tthwPath", argValue(argv, "--tthw"));
  const bundle = await collectEvidence(options);
  const report = buildGateReport(bundle);

  const out = argValue(argv, "--out");
  if (out) {
    const file = path.resolve(out);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
    if (out) {
      console.log(`report written: ${path.resolve(out)}`);
    }
  }

  if (argv.includes("--strict") && !report.allGatesSatisfied) {
    return 1;
  }
  return 0;
}

function printReport(report: GateReport): void {
  const passed = report.gates.filter((gate) => gate.status === "pass").length;
  console.log(
    `1.0 gate report — ${report.window.start} → ${report.window.end} (${report.window.days} days)`,
  );
  console.log(report.statement);
  console.log(`gates: ${passed}/${report.gates.length} have full evidence`);
  for (const gate of report.gates) {
    console.log("");
    console.log(
      `[${gate.status === "pass" ? "PASS" : "GAP "}] ${gate.id} ${gate.title}`,
    );
    console.log(`  requirement: ${gate.requirement}`);
    for (const check of gate.checks) {
      console.log(
        `  ${check.ok ? "ok  " : "GAP "} ${check.code}: ${check.detail}`,
      );
    }
    for (const evidence of gate.evidence) {
      console.log(`  evidence: ${evidence}`);
    }
  }
  console.log("");
  console.log("sources:");
  for (const source of report.sources) {
    const detail = source.detail ? ` — ${source.detail}` : "";
    console.log(
      `  [${source.status}] ${source.id} (${source.records} record(s)) ${source.path}${detail}`,
    );
  }
  if (!report.allGatesSatisfied) {
    console.log("");
    console.log(`gaps: ${report.gaps.length}`);
    for (const gap of report.gaps) {
      console.log(`  - ${gap}`);
    }
  }
}

function printHelp(): void {
  console.log(`Usage: bun run gates:report [options]

Options:
  --home <dir>              Kit home (default: KIT_HOME or ~/.agent-team-kit)
  --repo <dir>              Repository root (default: this checkout)
  --db <file>               SQLite store path (default: <home>/data/kit.db)
  --packs <dir>             Packs root (default: <repo>/packs)
  --signals <dir>           Signals root (default: <home>/signals)
  --sources <dir>           Installed sources root (default: <repo>/sources)
  --reactions <file>        Reaction samples JSONL (default: <signals>/reactions.jsonl)
  --supervisor-state <file> kit up supervisor state (default: <repo>/.tmp/supervisor/state.json)
  --tthw <file>             zero-config TTHW ledger (default: <home>/cold-start-tthw.json)
  --days <n>                Window days, 1-90 (default: ${DEFAULT_WINDOW_DAYS})
  --now <iso>               Window end timestamp (default: now; use for replay)
  --json                    Print the report as JSON
  --out <file>              Also write the JSON report to this file
  --strict                  Exit 1 when any gate is a GAP
  --help                    Show this help

Exit codes: 0 report produced, 1 --strict with gaps, 2 invalid arguments.
`);
}

type PathOptionKey =
  | "dbPath"
  | "packsRoot"
  | "signalsRoot"
  | "sourcesRoot"
  | "reactionsPath"
  | "supervisorStatePath"
  | "tthwPath";

function assignPath(
  options: CollectOptions,
  key: PathOptionKey,
  value: string | undefined,
): void {
  if (value) {
    options[key] = path.resolve(value);
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function numberArg(argv: string[], name: string): number | undefined {
  const raw = argValue(argv, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const invokedPath = process.argv[1];
const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (invokedPath !== undefined &&
    path.resolve(invokedPath) === fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 2;
    });
}
