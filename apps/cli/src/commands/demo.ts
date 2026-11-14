import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type LoadedPack,
  type SimulationReport,
  createPack,
  loadPack,
  simulatePack,
} from "@kit/pack";
import type { Command } from "commander";
import { kitCommand } from "../repo";

const TEAM_DIR = "research-team";

export function registerDemo(program: Command): void {
  program
    .command("demo")
    .description("Create a demo team and a static team plan (no Docker)")
    .option("--open", "open the generated plan in the browser", false)
    .action(async (options: { open: boolean }) => {
      const command = kitCommand();
      const demoRoot = path.join(kitHome(), "demo");
      const teamDir = path.join(demoRoot, TEAM_DIR);

      if (existsSync(path.join(teamDir, "team.yaml"))) {
        console.log(`✔ reusing demo team at ${teamDir}`);
      } else {
        try {
          await createPack({
            root: demoRoot,
            dirName: TEAM_DIR,
            name: "Research Team",
            description: "Demo team created by kit demo",
            template: "research",
            managerName: "manager",
            managerModel: "deepseek-pro",
          });
          console.log(`✔ demo team created at ${teamDir}`);
        } catch (error) {
          console.error(
            `✖ demo failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const loaded = await loadPack(teamDir);
      if (!loaded.ok) {
        console.error("✖ the demo team is invalid");
        for (const issue of loaded.errors) {
          console.error(`  - ${issue}`);
        }
        process.exitCode = 1;
        return;
      }

      const report = simulatePack(loaded);
      const htmlPath = path.join(demoRoot, "team-plan.html");
      await writeFile(htmlPath, renderPlan(loaded, report), "utf8");

      console.log(`✔ team plan written to ${htmlPath}`);
      console.log("  (static preview — no model call was made)");
      if (options.open) {
        openPath(htmlPath);
      }

      console.log("\nNext steps:");
      console.log(`  ${command} pack validate "${teamDir}"`);
      console.log(`  ${command} pack simulate "${teamDir}"`);
      console.log(`  ${command} up --web   # open /packs and run ${TEAM_DIR}`);
    });
}

function kitHome(): string {
  return process.env.KIT_HOME
    ? path.resolve(process.env.KIT_HOME)
    : path.join(os.homedir(), ".agent-team-kit");
}

function openPath(file: string): void {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", file] : [file];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

function renderPlan(loaded: LoadedPack, report: SimulationReport): string {
  const agents = [...loaded.agents.entries()]
    .map(([id, agent]) => {
      const frontmatter = agent.frontmatter;
      return `<li><strong>${escapeHtml(id)}</strong> · ${escapeHtml(agent.role)} · ${escapeHtml(frontmatter.model ?? "unknown")}<br/><span>${escapeHtml(frontmatter.description ?? "")}</span></li>`;
    })
    .join("\n");

  const workflows = report.workflows
    .map((workflow) => {
      const rows = workflow.stages
        .map((stage) => {
          const who = stage.agent ?? stage.coder ?? stage.type;
          return `<tr><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.type)}</td><td>${escapeHtml(who)}</td><td>${escapeHtml(stage.model ?? "—")}</td><td>¥${stage.estimatedCostCny.toFixed(4)}</td><td>${stage.gate ? escapeHtml(stage.gate) : "—"}</td></tr>`;
        })
        .join("\n");
      return `<section><h2>Workflow · ${escapeHtml(workflow.id)}</h2>
        <table><thead><tr><th>stage</th><th>type</th><th>agent</th><th>model</th><th>est. cost</th><th>gate</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">Estimated total: ¥${workflow.totalCostCny.toFixed(4)}</p></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(report.pack.name)} · Agent Team Kit</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 48px 24px; background: #09090b; color: #e4e4e7; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; color: #a1a1aa; text-transform: uppercase; letter-spacing: .08em; }
  .meta { color: #71717a; font-size: 12px; margin-bottom: 24px; }
  .badge { display: inline-block; border: 1px solid #3f3f46; border-radius: 999px; padding: 2px 10px; font-size: 11px; color: #d4d4d8; margin-right: 6px; }
  ul { padding-left: 18px; }
  li { margin: 8px 0; }
  li span { color: #a1a1aa; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #27272a; }
  th { color: #71717a; font-weight: 500; }
  .muted { color: #71717a; font-size: 12px; }
  .note { margin-top: 32px; border-left: 2px solid #3f3f46; padding: 8px 12px; color: #a1a1aa; font-size: 12px; }
  footer { margin-top: 40px; color: #52525b; font-size: 11px; }
</style>
</head>
<body>
<main>
  <span class="badge">Demo</span><span class="badge">No model call</span>
  <h1>${escapeHtml(report.pack.name)}</h1>
  <p class="meta">v${escapeHtml(report.pack.version)} · generated from your team files by Agent Team Kit</p>

  <section>
    <h2>People</h2>
    <ul>${agents}</ul>
  </section>

  ${workflows}

  <div class="note">${escapeHtml(report.note)} This plan is generated locally from the team files. Run the team through the console to produce real artifacts.</div>

  <footer>Generated by Agent Team Kit · team files live in ${escapeHtml(loaded.dir)}</footer>
</main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
