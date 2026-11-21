import { describe, expect, it } from "vitest";
import {
  type ImpactInput,
  LEGACY_OPS_REDIRECTS,
  OPS_SECTIONS,
  deriveImpactChain,
  legacyOpsRedirect,
  opsSectionHref,
  opsShortcutFor,
  resolveOpsSection,
  suggestionSection,
} from "../lib/ops-sections";

const CLEAN: ImpactInput = {
  alerts: [],
  modes: [],
  budgets: [],
  activeKillSwitches: 0,
  autopilot: { online: true, enabledPacks: 0 },
};

describe("ops section routing", () => {
  it("redirects every folded legacy route to its section", () => {
    expect(legacyOpsRedirect("/degradation")).toBe("/ops?section=degradation");
    expect(legacyOpsRedirect("/budgets")).toBe("/ops?section=budget");
    expect(legacyOpsRedirect("/kill-switch")).toBe("/ops?section=control");
    // Autopilot moved to its own control surface (`/triggers`, 96 §5.5).
    expect(legacyOpsRedirect("/autopilot")).toBeNull();
    expect(Object.keys(LEGACY_OPS_REDIRECTS)).toHaveLength(3);
    expect(legacyOpsRedirect("/runs")).toBeNull();
  });

  it("resolves known sections and defaults unknown values to alerts", () => {
    for (const section of OPS_SECTIONS) {
      expect(resolveOpsSection(section)).toBe(section);
      expect(resolveOpsSection([section])).toBe(section);
    }
    expect(resolveOpsSection("kill-switch")).toBe("alerts");
    expect(resolveOpsSection(undefined)).toBe("alerts");
    expect(resolveOpsSection("")).toBe("alerts");
  });

  it("builds canonical hrefs", () => {
    expect(opsSectionHref("alerts")).toBe("/ops");
    expect(opsSectionHref("degradation")).toBe("/ops?section=degradation");
    expect(opsSectionHref("budget")).toBe("/ops?section=budget");
    expect(opsSectionHref("control")).toBe("/ops?section=control");
  });

  it("maps d/b/k shortcuts and ignores modifiers or typing", () => {
    expect(opsShortcutFor("d")).toBe("degradation");
    expect(opsShortcutFor("b")).toBe("budget");
    expect(opsShortcutFor("k")).toBe("control");
    expect(opsShortcutFor("D")).toBe("degradation");
    expect(opsShortcutFor("k", { meta: true })).toBeNull();
    expect(opsShortcutFor("k", { ctrl: true })).toBeNull();
    expect(opsShortcutFor("b", { alt: true })).toBeNull();
    expect(opsShortcutFor("x")).toBeNull();
  });
});

describe("deriveImpactChain", () => {
  it("reports all clear when nothing is wrong", () => {
    const impact = deriveImpactChain(CLEAN);
    expect(impact.severity).toBe("ok");
    expect(impact.attention).toBe(false);
    expect(impact.suggestions).toEqual(["allClear"]);
  });

  it("flags a P0 alert as danger and suggests acknowledging", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      alerts: [{ tier: "P0", status: "open" }],
    });
    expect(impact.severity).toBe("danger");
    expect(impact.worstTier).toBe("P0");
    expect(impact.openAlerts).toBe(1);
    expect(impact.suggestions[0]).toBe("ackAlerts");
  });

  it("prefers the overdue suggestion when the ack SLA is breached", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      now: Date.parse("2026-11-19T12:00:00.000Z"),
      ackSlaMinutes: { P1: 5 },
      alerts: [
        {
          tier: "P1",
          status: "open",
          firstSeenAt: "2026-11-19T10:00:00.000Z",
        },
      ],
    });
    expect(impact.overdueAlerts).toBe(1);
    expect(impact.severity).toBe("warning");
    expect(impact.suggestions).toContain("ackOverdue");
    expect(impact.suggestions).not.toContain("ackAlerts");
  });

  it("treats read-only degradation as danger and links the exit", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      modes: [{ kind: "read_only" }],
    });
    expect(impact.severity).toBe("danger");
    expect(impact.modeKind).toBe("read_only");
    expect(impact.suggestions).toContain("exitDegradation");
    expect(suggestionSection("exitDegradation")).toBe("degradation");
  });

  it("detects budget pressure and pauses autopilot when enabled", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      budgets: [{ exceeded: true, alert: true, percent: 104.2 }],
      autopilot: { online: true, enabledPacks: 2 },
    });
    expect(impact.severity).toBe("danger");
    expect(impact.exceededBudgets).toBe(1);
    expect(impact.worstPercent).toBe(104.2);
    expect(impact.suggestions).toContain("increaseBudget");
    expect(impact.suggestions).toContain("pauseAutopilot");
  });

  it("warns on 80% budgets without an incident", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      budgets: [{ exceeded: false, alert: true, percent: 83 }],
    });
    expect(impact.severity).toBe("warning");
    expect(impact.suggestions).toContain("reviewBudget");
  });

  it("puts a kill switch first and caps suggestions at three", () => {
    const impact = deriveImpactChain({
      ...CLEAN,
      activeKillSwitches: 1,
      modes: [{ kind: "read_only" }],
      budgets: [{ exceeded: true, alert: true, percent: 120 }],
      alerts: [{ tier: "P0", status: "open" }],
      autopilot: { online: true, enabledPacks: 1 },
    });
    expect(impact.severity).toBe("danger");
    expect(impact.suggestions).toHaveLength(3);
    expect(impact.suggestions[0]).toBe("releaseKillSwitch");
    expect(impact.suggestions).toContain("exitDegradation");
    expect(impact.suggestions).toContain("increaseBudget");
  });

  it("maps every suggestion to a real section", () => {
    for (const suggestion of [
      "ackAlerts",
      "ackOverdue",
      "exitDegradation",
      "increaseBudget",
      "reviewBudget",
      "releaseKillSwitch",
      "pauseAutopilot",
      "allClear",
    ] as const) {
      expect(OPS_SECTIONS).toContain(suggestionSection(suggestion));
    }
  });
});
