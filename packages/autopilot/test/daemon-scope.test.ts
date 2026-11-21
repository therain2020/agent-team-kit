import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemon = readFileSync(path.resolve(here, "../src/daemon.ts"), "utf8");

/**
 * The daemon is a cron adapter plus heartbeat (96 §5.1/§5.3). Auto-approval
 * decisions live in `@kit/manager`, evolution execution in `@kit/job`; any of
 * these symbols reappearing here means the layering regressed.
 */
const REMOVED = [
  "processAutoApprovals",
  "processEvolution(",
  "runEvolutionCycle",
  "StoreEvolutionRepository",
  "decideApprovalRecord",
  "findApprovalRequest",
  "findDecisionForRequest",
  "signalApproval(",
  "RISK_RANK",
  "__evolution",
];

describe("daemon scope", () => {
  it("keeps auto-approval and evolution execution out of the daemon", () => {
    for (const symbol of REMOVED) {
      expect(daemon, `${symbol} must not live in the daemon`).not.toContain(
        symbol,
      );
    }
  });

  it("keeps cron adaptation and heartbeat in the daemon", () => {
    expect(daemon).toContain("nextCronOccurrence");
    expect(daemon).toContain("fireTrigger");
    expect(daemon).toContain("runApprovalTick");
  });
});
