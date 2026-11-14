import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type IterationSignal,
  proposeImprovements,
  summarizeSignals,
} from "@kit/evolution";
import type { Command } from "commander";

export function registerSignals(program: Command): void {
  const signals = program
    .command("signals")
    .description("Iteration fitness signals and improvement proposals");

  signals
    .command("list")
    .description("List recent iteration signals")
    .option("--limit <n>", "number of signals", "20")
    .action(async (options: { limit: string }) => {
      const all = await readSignals();
      const limit = Math.max(1, Number(options.limit) || 20);
      console.log(JSON.stringify(all.slice(-limit), null, 2));
    });

  signals
    .command("summarize")
    .description("Aggregate pass/apply rates by domain")
    .action(async () => {
      console.log(
        JSON.stringify(summarizeSignals(await readSignals()), null, 2),
      );
    });

  signals
    .command("propose")
    .description("Write improvement proposals for low-pass domains")
    .option("--dry-run", "print proposals without writing files", false)
    .action(async (options: { dryRun: boolean }) => {
      const proposals = proposeImprovements(
        summarizeSignals(await readSignals()),
      );
      if (proposals.length === 0) {
        console.log(
          "No proposals: no domain is below the pass-rate threshold.",
        );
        return;
      }
      const files: string[] = [];
      if (!options.dryRun) {
        const dir = proposalsDir();
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        for (const proposal of proposals) {
          const file = path.join(dir, `${stamp}-${proposal.domain}.md`);
          await writeFile(file, renderProposal(proposal), "utf8");
          files.push(file);
        }
      }
      console.log(JSON.stringify({ proposals, files }, null, 2));
    });
}

function signalsFile(): string {
  const root =
    process.env.KIT_SIGNALS_ROOT ??
    path.join(os.homedir(), ".agent-team-kit", "signals");
  return path.join(root, "iterations.jsonl");
}

function proposalsDir(): string {
  return (
    process.env.KIT_PROPOSALS_ROOT ??
    path.join(os.homedir(), ".agent-team-kit", "proposals")
  );
}

async function readSignals(): Promise<IterationSignal[]> {
  const file = signalsFile();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as IterationSignal];
      } catch {
        return [];
      }
    });
}

function renderProposal(proposal: {
  domain: string;
  title: string;
  rationale: string;
  suggestedRules: string[];
}): string {
  return `# Proposal: ${proposal.title}

- Domain: ${proposal.domain}
- Rationale: ${proposal.rationale}
- Status: proposed (manual review; not auto-applied)

## Suggested rules

${proposal.suggestedRules.map((rule) => `- ${rule}`).join("\n")}

## Evidence

Generated from \`${signalsFile()}\`.
Review the latest iteration report before editing the domain agent.
`;
}
