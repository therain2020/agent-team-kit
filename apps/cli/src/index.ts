#!/usr/bin/env bun
import { Command } from "commander";
import { registerApprove } from "./commands/approve";
import { registerBootstrap } from "./commands/bootstrap";
import { registerDemo } from "./commands/demo";
import { registerDev } from "./commands/dev";
import { registerDoctor } from "./commands/doctor";
import { registerEvent } from "./commands/event";
import { registerEvolve } from "./commands/evolve";
import { registerInit } from "./commands/init";
import { registerIterate } from "./commands/iterate";
import { registerJob } from "./commands/job";
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
import { registerWorkshop } from "./commands/workshop";
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
registerIterate(program);
registerSignals(program);
registerWorkshop(program);

await program.parseAsync().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
