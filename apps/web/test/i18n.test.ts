import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value]]
      : flatten(value, `${prefix}${key}.`),
  );
}

const enEntries = flatten(en);
const zhEntries = flatten(zh);

describe("console messages", () => {
  it("keeps en and zh on the same key set", () => {
    const enKeys = enEntries.map(([key]) => key).sort();
    const zhKeys = zhEntries.map(([key]) => key).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("ships no empty strings", () => {
    for (const [key, value] of [...enEntries, ...zhEntries]) {
      expect(value.trim(), key).not.toBe("");
    }
  });
});
