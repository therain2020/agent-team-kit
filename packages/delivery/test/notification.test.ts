import { describe, expect, it } from "vitest";
import { deliverNotification } from "../src/index";

describe("deliverNotification", () => {
  it("short-circuits in dry-run mode", async () => {
    const result = await deliverNotification({
      channel: "email",
      subject: "[P0] test",
      text: "body",
      dryRun: true,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("reports missing SMTP configuration", async () => {
    const result = await deliverNotification({
      channel: "email",
      subject: "[P1] test",
      text: "body",
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("KIT_SMTP_HOST");
  });

  it("reports a missing webhook URL for IM", async () => {
    const result = await deliverNotification({
      channel: "im",
      subject: "[P0] test",
      text: "body",
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("KIT_DELIVERY_WEBHOOK_URL");
  });
});
