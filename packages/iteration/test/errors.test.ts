import { describe, expect, it } from "vitest";
import { asText, toErrorMessage } from "../src/errors";

describe("toErrorMessage", () => {
  it("returns strings unchanged", () => {
    expect(toErrorMessage("boom")).toBe("boom");
  });

  it("extracts messages from Error and plain objects", () => {
    expect(toErrorMessage(new Error("bad plan"))).toBe("bad plan");
    expect(toErrorMessage({ message: "bad shape" })).toBe("bad shape");
  });

  it("stringifies objects without a message", () => {
    expect(toErrorMessage({ code: "invalid_type" })).toBe(
      '{"code":"invalid_type"}',
    );
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
  });
});

describe("asText", () => {
  it("falls back for nullish values and coerces objects", () => {
    expect(asText(undefined)).toBe("");
    expect(asText(null, "fallback")).toBe("fallback");
    expect(asText({ message: "x" })).toBe("x");
  });
});
