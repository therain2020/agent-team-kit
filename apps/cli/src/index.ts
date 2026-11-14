#!/usr/bin/env bun
import { Command } from "commander";
import { registerApprove } from "./commands/approve";
import { registerDev } from "./commands/dev";
import { registerEvolve } from "./commands/evolve";
import { registerInit } from "./commands/init";
import { registerManager } from "./commands/manager";
import { registerModel } from "./commands/model";
import { registerPack } from "./commands/pack";
import { registerPatch } from "./commands/patch";
import { registerRun } from "./commands/run";
import { registerSource } from "./commands/source";
import { registerStatus } from "./commands/status";

const program = new Command();

program.name("kit").description("Agent Team Kit CLI").version("1.0.0");

registerInit(program);
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

program.parse();
