import { describe, expect, it } from "vitest";
import {
  AVATAR_PIXEL_COUNT,
  DEFAULT_AVATAR,
  avatarColorAt,
  avatarDiff,
  avatarPixelIndexAt,
  avatarRects,
  avatarSpecSchema,
  parseSpriteCode,
  spriteCode,
  spriteCodeBytes,
} from "../src";

function withPixels(pixels: string) {
  return { ...DEFAULT_AVATAR, pixels };
}

function issuePaths(error: { issues: Array<{ path: (string | number)[] }> }) {
  return error.issues.map((issue) => issue.path.join("."));
}

describe("avatar spec schema", () => {
  it("accepts the default 16×24 sprite", () => {
    const parsed = avatarSpecSchema.parse(DEFAULT_AVATAR);
    expect(parsed.width).toBe(16);
    expect(parsed.height).toBe(24);
    expect(parsed.pixels).toHaveLength(AVATAR_PIXEL_COUNT);
    expect(parsed.palette.length).toBeLessThanOrEqual(16);
    expect(parsed.palette.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(
      true,
    );
  });

  it("rejects wrong version, width and height", () => {
    const version = avatarSpecSchema.safeParse({
      ...DEFAULT_AVATAR,
      version: 2,
    });
    expect(version.success).toBe(false);
    const width = avatarSpecSchema.safeParse({ ...DEFAULT_AVATAR, width: 15 });
    expect(width.success).toBe(false);
    const height = avatarSpecSchema.safeParse({
      ...DEFAULT_AVATAR,
      height: 23,
    });
    expect(height.success).toBe(false);
  });

  it("rejects palettes over 16 colors or with bad hex", () => {
    const many = Array.from({ length: 17 }, (_, index) =>
      `#00000${index.toString(16)}`.slice(0, 7),
    );
    const tooMany = avatarSpecSchema.safeParse({
      ...DEFAULT_AVATAR,
      palette: many,
    });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(issuePaths(tooMany.error)).toContain("palette");
    }

    for (const bad of ["#GGGGGG", "123456", "#12345", "#1234567", "#ABCDEF"]) {
      const parsed = avatarSpecSchema.safeParse({
        ...DEFAULT_AVATAR,
        palette: [bad],
        pixels: ".".repeat(AVATAR_PIXEL_COUNT),
      });
      expect(parsed.success, bad).toBe(false);
    }
  });

  it("rejects wrong pixel length and non-whitelisted characters", () => {
    const short = avatarSpecSchema.safeParse(withPixels(".".repeat(383)));
    expect(short.success).toBe(false);
    if (!short.success) {
      expect(issuePaths(short.error)).toContain("pixels");
    }

    for (const bad of ["g", "#", "\n", "A", " "]) {
      const parsed = avatarSpecSchema.safeParse(
        withPixels(bad + ".".repeat(AVATAR_PIXEL_COUNT - 1)),
      );
      expect(parsed.success, bad).toBe(false);
    }
  });

  it("rejects a pixel index beyond the palette", () => {
    // Palette has 7 colors (indices 0-6); index 7 is out of range.
    const parsed = avatarSpecSchema.safeParse(withPixels("7".repeat(384)));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(issuePaths(parsed.error)).toContain("pixels");
      expect(parsed.error.issues[0]?.message).toMatch(/palette index 7/);
    }
  });

  it("reads colors and rects only from valid indices", () => {
    expect(avatarColorAt(DEFAULT_AVATAR, 6, 7)).toBe("#1f2937");
    expect(avatarColorAt(DEFAULT_AVATAR, 0, 0)).toBeNull();
    expect(avatarPixelIndexAt(DEFAULT_AVATAR, 99, 99)).toBeNull();
    const rects = avatarRects(DEFAULT_AVATAR);
    expect(rects.length).toBe(
      [...DEFAULT_AVATAR.pixels].filter((char) => char !== ".").length,
    );
    expect(rects.every((rect) => rect.color.startsWith("#"))).toBe(true);
  });
});

describe("sprite code", () => {
  it("round-trips through JSON without losing data", () => {
    const code = spriteCode(DEFAULT_AVATAR);
    const parsed = parseSpriteCode(code);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.avatar).toEqual(DEFAULT_AVATAR);
      expect(spriteCode(parsed.avatar)).toBe(code);
    }
  });

  it("rejects code, HTML and malformed JSON without executing it", () => {
    for (const text of [
      "alert(1)",
      "<script>alert(1)</script>",
      '{"avatar": "<img onerror=alert(1)>"}',
      "",
    ]) {
      const parsed = parseSpriteCode(text);
      expect(parsed.ok, text).toBe(false);
    }
    const wrongShape = parseSpriteCode(
      JSON.stringify({ ...DEFAULT_AVATAR, pixels: "0".repeat(10) }),
    );
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) {
      expect(wrongShape.errors.some((line) => line.startsWith("pixels:"))).toBe(
        true,
      );
    }
  });

  it("stays inside the 2KB frontmatter budget", () => {
    expect(spriteCodeBytes(DEFAULT_AVATAR)).toBeLessThanOrEqual(2048);
    const full = avatarSpecSchema.parse({
      ...DEFAULT_AVATAR,
      palette: Array.from(
        { length: 16 },
        (_, index) => `#${index.toString(16).repeat(6)}`,
      ),
      pixels: "f".repeat(384),
    });
    expect(spriteCodeBytes(full)).toBeLessThanOrEqual(2048);
  });
});

describe("avatar diff", () => {
  it("counts added, erased and changed pixels against empty", () => {
    const diff = avatarDiff(null, DEFAULT_AVATAR);
    const ink = [...DEFAULT_AVATAR.pixels].filter(
      (char) => char !== ".",
    ).length;
    expect(diff.changed).toBe(ink);
    expect(diff.added).toBe(ink);
    expect(diff.removed).toBe(0);
    expect(diff.paletteAdded).toEqual(DEFAULT_AVATAR.palette);
    expect(diff.bytes).toBeGreaterThan(0);
  });

  it("reports no changes for identical avatars", () => {
    const diff = avatarDiff(DEFAULT_AVATAR, { ...DEFAULT_AVATAR });
    expect(diff.changed).toBe(0);
    expect(diff.paletteAdded).toEqual([]);
    expect(diff.paletteRemoved).toEqual([]);
  });
});
