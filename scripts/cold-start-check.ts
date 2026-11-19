#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_FILES = [
  "README.md",
  "CHECKLIST.md",
  "template.yaml",
  "baseline-eval.md",
  "golden-set.yaml",
  "seed-artifacts.yaml",
  "sources.yaml",
  "budget.yaml",
] as const;

export interface ColdStartCheck {
  id: string;
  ok: boolean;
  detail: string;
  missing: string[];
}

export interface ColdStartReport {
  ok: boolean;
  root: string;
  checks: ColdStartCheck[];
  missing: string[];
}

interface ListEntry {
  fields: Record<string, string>;
}

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "cold-start",
);

export function checkColdStartPackage(root: string): ColdStartReport {
  const packageRoot = path.resolve(root);
  const contents = new Map<string, string>();
  const missingFiles: string[] = [];

  for (const file of REQUIRED_FILES) {
    const full = path.join(packageRoot, file);
    if (!existsSync(full)) {
      missingFiles.push(file);
      continue;
    }
    contents.set(file, readFileSync(full, "utf8"));
  }

  const filesOk = missingFiles.length === 0;
  const checks: ColdStartCheck[] = [
    result(
      "files",
      filesOk,
      filesOk
        ? `${REQUIRED_FILES.length} required files present`
        : `${missingFiles.length} of ${REQUIRED_FILES.length} files missing`,
      missingFiles,
    ),
    checkTemplate(contents.get("template.yaml") ?? ""),
    checkGoldenSet(contents.get("golden-set.yaml") ?? ""),
    checkSeedArtifacts(contents.get("seed-artifacts.yaml") ?? ""),
    checkSources(contents.get("sources.yaml") ?? ""),
    checkBudget(contents.get("budget.yaml") ?? ""),
    checkChecklist(contents.get("CHECKLIST.md") ?? ""),
  ];

  return {
    ok: checks.every((check) => check.ok),
    root: packageRoot,
    checks,
    missing: checks.flatMap((check) => check.missing),
  };
}

function checkTemplate(text: string): ColdStartCheck {
  const missing: string[] = [];
  requireValue(text, missing, "template.yaml", "apiVersion", "agentteam/v1");
  requireValue(text, missing, "template.yaml", "kind", "TeamTemplate");
  requireValue(text, missing, "template.yaml", "id", "cold-start");

  const workflow = block(text, "workflow");
  if (!workflow) {
    missing.push("template.yaml: workflow");
  } else if (!/^\s*stages\s*:/m.test(workflow)) {
    missing.push("template.yaml: workflow.stages");
  } else {
    if (count(workflow, /approval\s*:/g) < 3) {
      missing.push("template.yaml: an approval on every stage");
    }
    if (count(workflow, /mode\s*:\s*required\b/g) < 3) {
      missing.push("template.yaml: approval.mode required on every stage");
    }
  }

  const policy = block(text, "policy");
  if (!policy) {
    missing.push("template.yaml: policy");
  } else {
    const rules = ["tool.web_search", "tool.fetch", "tool.deliver_external"];
    for (const rule of rules) {
      const line = findLine(policy, rule);
      if (!line) {
        missing.push(`template.yaml: policy action ${rule}`);
      } else if (!line.includes("approval:")) {
        missing.push(`template.yaml: policy action ${rule} needs approval`);
      }
    }
    if (!findLine(policy, "tool.delete")) {
      missing.push("template.yaml: policy action tool.delete");
    }
  }

  const autopilot = block(text, "autopilot");
  if (!autopilot) {
    missing.push("template.yaml: autopilot");
  } else {
    if (value(autopilot, "enabled") !== "false") {
      missing.push("template.yaml: autopilot.enabled false");
    }
    const approval = blockAt(autopilot, "autoApprove", 4);
    if (!approval) {
      missing.push("template.yaml: autopilot.approval.autoApprove");
    } else {
      if (value(approval, "enabled") !== "false") {
        missing.push("template.yaml: autoApprove.enabled false");
      }
      if (value(approval, "maxRisk") !== "low") {
        missing.push("template.yaml: autoApprove.maxRisk low");
      }
      if (value(approval, "onTimeout") !== "wait") {
        missing.push("template.yaml: autoApprove.onTimeout wait");
      }
    }
    const evolution = blockAt(autopilot, "evolution", 2);
    if (!evolution) {
      missing.push("template.yaml: autopilot.evolution");
    } else if (value(evolution, "enabled") !== "false") {
      missing.push("template.yaml: evolution.enabled false");
    }
  }

  return result(
    "template",
    missing.length === 0,
    missing.length === 0
      ? "conservative template policy present"
      : `${missing.length} template field(s) missing`,
    missing,
  );
}

function checkGoldenSet(text: string): ColdStartCheck {
  const missing: string[] = [];
  requireKey(text, missing, "golden-set.yaml", "version");
  requireKey(text, missing, "golden-set.yaml", "tenant");
  requireKey(text, missing, "golden-set.yaml", "cases");

  const forbidden =
    /\b(scores?|average|pass_?rate|verdict|passed|failed)\s*:/i.exec(
      stripComments(text),
    );
  if (forbidden) {
    missing.push(
      `golden-set.yaml: no scores in the golden set (${forbidden[1]})`,
    );
  }

  for (const [index, entry] of entriesOf(text, "cases").entries()) {
    const scope = `golden-set.yaml: cases[${index}]`;
    requireField(entry, missing, scope, "case_id");
    requireField(entry, missing, scope, "tenant_id");
    requireFieldPresent(entry, missing, scope, "input_refs");
    requireFieldPresent(entry, missing, scope, "expected_refs");
    requireField(entry, missing, scope, "approved_by");
  }

  return result(
    "golden-set",
    missing.length === 0,
    missing.length === 0
      ? "golden-set skeleton follows the 40 contract"
      : `${missing.length} golden-set field(s) missing`,
    missing,
  );
}

function checkSeedArtifacts(text: string): ColdStartCheck {
  const missing: string[] = [];
  requireKey(text, missing, "seed-artifacts.yaml", "version");
  requireKey(text, missing, "seed-artifacts.yaml", "artifacts");

  for (const [index, entry] of entriesOf(text, "artifacts").entries()) {
    const scope = `seed-artifacts.yaml: artifacts[${index}]`;
    for (const field of ["id", "title", "kind", "owner"]) {
      requireField(entry, missing, scope, field);
    }
  }

  return result(
    "seed-artifacts",
    missing.length === 0,
    missing.length === 0
      ? "seed artifact list present"
      : `${missing.length} seed artifact field(s) missing`,
    missing,
  );
}

function checkSources(text: string): ColdStartCheck {
  const missing: string[] = [];
  requireKey(text, missing, "sources.yaml", "version");
  requireKey(text, missing, "sources.yaml", "sources");

  for (const [index, entry] of entriesOf(text, "sources").entries()) {
    const scope = `sources.yaml: sources[${index}]`;
    requireField(entry, missing, scope, "name");
    requireField(entry, missing, scope, "cadence");
    requireField(entry, missing, scope, "owner");
    if (!hasField(entry, "url") && !hasField(entry, "topic")) {
      missing.push(`${scope}: url or topic`);
    }
  }

  return result(
    "sources",
    missing.length === 0,
    missing.length === 0
      ? "source inventory present"
      : `${missing.length} source field(s) missing`,
    missing,
  );
}

function checkBudget(text: string): ColdStartCheck {
  const missing: string[] = [];
  requireKey(text, missing, "budget.yaml", "version");

  const currency = value(text, "currency");
  if (currency === "") {
    missing.push("budget.yaml: currency");
  } else if (currency.toUpperCase() !== "CNY") {
    missing.push("budget.yaml: currency CNY");
  }

  const dailyRuns = numberValue(text, "dailyRuns");
  const dailyCost = numberValue(text, "dailyCostCny");
  const monthlyRuns = numberValue(text, "monthlyRuns");
  const monthlyCost = numberValue(text, "monthlyCostCny");
  const values: Array<[string, number | null]> = [
    ["dailyRuns", dailyRuns],
    ["dailyCostCny", dailyCost],
    ["monthlyRuns", monthlyRuns],
    ["monthlyCostCny", monthlyCost],
  ];
  for (const [key, parsed] of values) {
    if (parsed === null) {
      missing.push(`budget.yaml: ${key}`);
    }
  }

  const runCaps = block(text, "runCaps");
  if (!runCaps) {
    missing.push("budget.yaml: runCaps");
  } else {
    const runCost = numberValue(runCaps, "costCny");
    const runTokens = numberValue(runCaps, "tokens");
    const runClock = numberValue(runCaps, "wallClockSeconds");
    if (runCost === null) {
      missing.push("budget.yaml: runCaps.costCny");
    }
    if (runTokens === null || runTokens <= 0) {
      missing.push("budget.yaml: runCaps.tokens");
    }
    if (runClock === null || runClock <= 0) {
      missing.push("budget.yaml: runCaps.wallClockSeconds");
    }
  }

  if (dailyRuns !== null && monthlyRuns !== null && dailyRuns > monthlyRuns) {
    missing.push("budget.yaml: dailyRuns must not exceed monthlyRuns");
  }
  if (dailyCost !== null && monthlyCost !== null && dailyCost > monthlyCost) {
    missing.push("budget.yaml: dailyCostCny must not exceed monthlyCostCny");
  }
  if (dailyRuns !== null && (!Number.isInteger(dailyRuns) || dailyRuns < 1)) {
    missing.push("budget.yaml: dailyRuns must be a positive integer");
  }
  if (
    monthlyRuns !== null &&
    (!Number.isInteger(monthlyRuns) || monthlyRuns < 1)
  ) {
    missing.push("budget.yaml: monthlyRuns must be a positive integer");
  }

  return result(
    "budget",
    missing.length === 0,
    missing.length === 0
      ? "daily/monthly CNY and run caps present"
      : `${missing.length} budget field(s) missing`,
    missing,
  );
}

function checkChecklist(text: string): ColdStartCheck {
  const missing: string[] = [];
  for (const item of ["CS-1", "CS-2", "CS-3", "CS-4", "CS-5", "CS-6"]) {
    if (!text.includes(item)) {
      missing.push(`CHECKLIST.md: ${item}`);
    }
  }
  for (const section of [
    "| Evidence |",
    "## Evidence log",
    "## Pass-rate record",
    "## Sign-off",
  ]) {
    if (!text.includes(section)) {
      missing.push(`CHECKLIST.md: ${section}`);
    }
  }
  if (!text.includes("90%")) {
    missing.push("CHECKLIST.md: 90% first-pass threshold");
  }

  return result(
    "checklist",
    missing.length === 0,
    missing.length === 0
      ? "executable checklist with evidence flow present"
      : `${missing.length} checklist item(s) missing`,
    missing,
  );
}

function result(
  id: string,
  ok: boolean,
  detail: string,
  missing: string[],
): ColdStartCheck {
  return { id, ok, detail, missing };
}

function requireKey(
  text: string,
  missing: string[],
  file: string,
  key: string,
): void {
  if (!new RegExp(`^\\s*${escapeKey(key)}\\s*:`, "m").test(text)) {
    missing.push(`${file}: ${key}`);
  }
}

function requireValue(
  text: string,
  missing: string[],
  file: string,
  key: string,
  expected: string,
): void {
  const actual = value(text, key);
  if (actual === "") {
    missing.push(`${file}: ${key}`);
  } else if (actual !== expected) {
    missing.push(`${file}: ${key} ${expected} (found ${actual})`);
  }
}

function requireField(
  entry: ListEntry,
  missing: string[],
  scope: string,
  key: string,
): void {
  if ((entry.fields[key] ?? "") === "") {
    missing.push(`${scope}: ${key}`);
  }
}

function requireFieldPresent(
  entry: ListEntry,
  missing: string[],
  scope: string,
  key: string,
): void {
  if (!hasField(entry, key)) {
    missing.push(`${scope}: ${key}`);
  }
}

function hasField(entry: ListEntry, key: string): boolean {
  return Object.hasOwn(entry.fields, key);
}

function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function value(text: string, key: string): string {
  const match = new RegExp(`^\\s*${escapeKey(key)}\\s*:\\s*(.*)$`, "m").exec(
    text,
  );
  if (!match) {
    return "";
  }
  return (match[1] ?? "").replace(/\s+#.*$/, "").trim();
}

function numberValue(text: string, key: string): number | null {
  const raw = value(text, key);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function findLine(text: string, needle: string): string | null {
  const line = text.split(/\r?\n/).find((item) => item.includes(needle));
  return line ?? null;
}

function block(text: string, key: string): string {
  return blockAt(text, key, 0);
}

function blockAt(text: string, key: string, indent: number): string {
  const lines = text.split(/\r?\n/);
  const prefix = " ".repeat(indent);
  const start = lines.findIndex((line) => line.startsWith(`${prefix}${key}:`));
  if (start < 0) {
    return "";
  }
  const collected = [lines[start] ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      collected.push(line);
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n");
}

function entriesOf(text: string, key: string): ListEntry[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^${escapeKey(key)}\\s*:`).test(line),
  );
  if (start < 0) {
    return [];
  }
  if (/:\s*\[\s*\]\s*(?:#.*)?$/.test(lines[start] ?? "")) {
    return [];
  }

  const entries: ListEntry[] = [];
  let current: ListEntry | null = null;
  let itemIndent: number | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (lineIndent === 0 && !item) {
      break;
    }
    if (item) {
      const indent = (item[1] ?? "").length;
      if (itemIndent === null) {
        itemIndent = indent;
      }
      if (indent !== itemIndent) {
        continue;
      }
      current = { fields: {} };
      entries.push(current);
      const inline = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(item[2] ?? "");
      if (inline) {
        current.fields[inline[1] ?? ""] = (inline[2] ?? "").trim();
      }
      continue;
    }
    if (current && itemIndent !== null && lineIndent === itemIndent + 2) {
      const field = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (field) {
        current.fields[field[1] ?? ""] = (field[2] ?? "").trim();
      }
    }
  }
  return entries;
}

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePackageRoot(input: string | undefined): string {
  if (!input) {
    return defaultRoot;
  }
  const candidate = path.resolve(input);
  const nested = path.join(candidate, "templates", "cold-start");
  const hasChecklist = existsSync(path.join(candidate, "CHECKLIST.md"));
  return !hasChecklist && existsSync(nested) ? nested : candidate;
}

function runCli(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const rootFlag = argv.indexOf("--root");
  const inlineRoot = argv.find((arg) => arg.startsWith("--root="));
  let rootInput: string | undefined;
  if (rootFlag >= 0) {
    rootInput = argv[rootFlag + 1];
  } else if (inlineRoot) {
    rootInput = inlineRoot.slice("--root=".length);
  }
  const report = checkColdStartPackage(resolvePackageRoot(rootInput));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`cold-start package: ${report.root}`);
    for (const check of report.checks) {
      const status = check.ok ? "ok" : "FAIL";
      console.log(`[${status}] ${check.id} — ${check.detail}`);
      for (const item of check.missing) {
        console.log(`  missing: ${item}`);
      }
    }
    const passed = report.checks.filter((check) => check.ok).length;
    console.log(`result: ${passed}/${report.checks.length} checks passed`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (invokedPath !== undefined &&
    path.resolve(invokedPath) === fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
