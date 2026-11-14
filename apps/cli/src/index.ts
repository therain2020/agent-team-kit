#!/usr/bin/env bun
import { Command } from "commander";
import { registerApprove } from "./commands/approve";
import { registerDev } from "./commands/dev";
import { registerEvent } from "./commands/event";
import { registerEvolve } from "./commands/evolve";
import { registerInit } from "./commands/init";
import { registerIterate } from "./commands/iterate";
import { registerManager } from "./commands/manager";
import { registerModel } from "./commands/model";
import { registerPack } from "./commands/pack";
import { registerPatch } from "./commands/patch";
import { registerRun } from "./commands/run";
import { registerSource } from "./commands/source";
import { registerStatus } from "./commands/status";
import { registerUp } from "./commands/up";

const program = new Command();

program.name("kit").description("Agent Team Kit CLI").version("0.9.0");

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
registerEvent(program);
registerUp(program);
registerIterate(program);

program.parse();
