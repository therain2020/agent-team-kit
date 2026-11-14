import { afterEach, describe, expect, it } from "vitest";
import { authorizeApprovalApi } from "../lib/approval-auth";

const original = process.env.KIT_APPROVAL_TOKEN;

afterEach(() => {
  if (original === undefined) {
    Reflect.deleteProperty(process.env, "KIT_APPROVAL_TOKEN");
  } else {
    process.env.KIT_APPROVAL_TOKEN = original;
  }
});

describe("approval api auth", () => {
  it("is disabled without a configured token", () => {
    Reflect.deleteProperty(process.env, "KIT_APPROVAL_TOKEN");
    const result = authorizeApprovalApi(
      new Request("http://localhost/api/approvals"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("rejects a missing or wrong bearer token", () => {
    process.env.KIT_APPROVAL_TOKEN = "secret";
    expect(authorizeApprovalApi(new Request("http://localhost")).ok).toBe(
      false,
    );
    expect(
      authorizeApprovalApi(
        new Request("http://localhost", {
          headers: { authorization: "Bearer wrong" },
        }),
      ).ok,
    ).toBe(false);
  });

  it("accepts the token header or x-kit-token", () => {
    process.env.KIT_APPROVAL_TOKEN = "secret";
    expect(
      authorizeApprovalApi(
        new Request("http://localhost", {
          headers: { authorization: "Bearer secret" },
        }),
      ).ok,
    ).toBe(true);
    expect(
      authorizeApprovalApi(
        new Request("http://localhost", {
          headers: { "x-kit-token": "secret" },
        }),
      ).ok,
    ).toBe(true);
  });
});
