#!/usr/bin/env bun
import { Command } from "commander";
import { registerAgent } from "./commands/agent";
import { registerApprove } from "./commands/approve";
import { registerAutonomy } from "./commands/autonomy";
import { registerBootstrap } from "./commands/bootstrap";
import { registerComponents } from "./commands/components";
import { registerDemo } from "./commands/demo";
import { registerDev } from "./commands/dev";
import { registerDoctor } from "./commands/doctor";
import { registerEvent } from "./commands/event";
import { registerEvolve } from "./commands/evolve";
import { registerInit } from "./commands/init";
import { registerIterate } from "./commands/iterate";
import { registerJob } from "./commands/job";
import { registerKillSwitch } from "./commands/kill-switch";
import { registerManager } from "./commands/manager";
import { registerModel } from "./commands/model";
import { registerPack } from "./commands/pack";
import { registerPatch } from "./commands/patch";
import { registerPublish } from "./commands/publish";
import { registerRun } from "./commands/run";
import { registerSignals } from "./commands/signals";
import { registerSource } from "./commands/source";
import { registerStatus } from "./commands/status";
import { registerUp } from "./commands/up";
import { registerWatch } from "./commands/watch";
import { registerWorkshop } from "./commands/workshop";
import { emitError } from "./output";
import { kitCommand } from "./repo";

const program = new Command();

program
  .name("kit")
  .description("Private agent teams with approvals and audit")
  .version("0.9.0")
  .action(() => {
    const command = kitCommand();
    console.log(
      [
        "Agent Team Kit 0.9.0 — private agent teams with approvals and audit.",
        "",
        "Start here:",
        `  ${command} bootstrap      connect a model with one API key`,
        `  ${command} doctor         check Bun, Node, Docker, ports and keys`,
        `  ${command} demo           create a demo team and a static plan (no Docker)`,
        `  ${command} init my-team   create a team from a template (--list)`,
        `  ${command} up --web       start the stack and the console`,
        `  ${command} publish <run>   render a run as a static site (GitHub Pages)`,
        "",
        "Docs: README.md · docs/install.md",
        "Community: CONTRIBUTING.md · SUPPORT.md",
      ].join("\n"),
    );
  });

registerInit(program);
registerBootstrap(program);
registerComponents(program);
registerDoctor(program);
registerDemo(program);
registerPublish(program);
registerPack(program);
registerPatch(program);
registerRun(program);
registerStatus(program);
registerModel(program);
registerSource(program);
registerManager(program);
registerApprove(program);
registerEvolve(program);
registerDev(program);
registerEvent(program);
registerUp(program);
registerJob(program);
registerKillSwitch(program);
registerIterate(program);
registerSignals(program);
registerWatch(program);
registerWorkshop(program);
registerAutonomy(program);
registerAgent(program);

// Unhandled action rejections are classified into the shared error-code table.
// `--json` may live after a subcommand, so inspect argv for the envelope shape.
await program.parseAsync().catch((error: unknown) => {
  emitError(process.argv.includes("--json"), error);
});
