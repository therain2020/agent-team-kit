import { z } from "zod";

/**
 * Agent avatar (97 §3.4): a 16×24 indexed pixel sprite stored as plain data in
 * the agent frontmatter. It is never markup and never code — the renderer only
 * emits controlled `<rect>`s from the validated palette and index string.
 *
 * Security invariants (97 §3.4/§5):
 * - fixed 16×24 canvas, exactly 384 pixels;
 * - palette ≤16 colors, each exactly `#rrggbb` (lowercase);
 * - pixel string only `[0-9a-f.]`, and every index < palette.length.
 *
 * The schema is strict: an invalid avatar fails the whole Pack load and can
 * never be persisted. Rendering callers use `normalizeAvatar` to fall back to
 * the default procedural sprite instead of crashing.
 */

export const AVATAR_VERSION = 1;
export const AVATAR_WIDTH = 16;
export const AVATAR_HEIGHT = 24;
export const AVATAR_PIXEL_COUNT = AVATAR_WIDTH * AVATAR_HEIGHT;
export const AVATAR_MAX_PALETTE = 16;
/** Upper bound for the `avatar` block added to one agent frontmatter. */
export const AVATAR_MAX_FRONTMATTER_BYTES = 2048;

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const PIXEL_CHARS = /^[0-9a-f.]+$/;

export const avatarSpecSchema = z
  .object({
    version: z.literal(AVATAR_VERSION),
    width: z.literal(AVATAR_WIDTH),
    height: z.literal(AVATAR_HEIGHT),
    palette: z
      .array(
        z.string().regex(HEX_COLOR, "palette colors must be lowercase #rrggbb"),
      )
      .max(
        AVATAR_MAX_PALETTE,
        `palette cannot exceed ${AVATAR_MAX_PALETTE} colors`,
      ),
    pixels: z
      .string()
      .length(
        AVATAR_PIXEL_COUNT,
        `pixels must be exactly ${AVATAR_PIXEL_COUNT} characters`,
      )
      .regex(PIXEL_CHARS, "pixels may only contain [0-9a-f.]"),
  })
  .superRefine((avatar, ctx) => {
    for (let index = 0; index < avatar.pixels.length; index += 1) {
      const char = avatar.pixels[index];
      if (char === "." || char === undefined) {
        continue;
      }
      const paletteIndex = Number.parseInt(char, 16);
      if (paletteIndex >= avatar.palette.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pixel ${index} uses palette index ${paletteIndex} but palette has ${avatar.palette.length} colors`,
          path: ["pixels"],
        });
        // One issue per offending pixel would flood the response; the first
        // failure per sprite is enough to reject the save.
        return;
      }
    }
  });

export type AvatarSpec = z.infer<typeof avatarSpecSchema>;

export interface AvatarRect {
  x: number;
  y: number;
  color: string;
}

/**
 * Canonical default sprite drawn in the palette of the first seed palette.
 * Studio "start from default" and the editor's blank canvas begin here.
 * Palette slots: 0 hair, 1 shirt, 2 pants, 3 skin, 4 boots, 5 eyes, 6 mouth.
 */
export const DEFAULT_AVATAR_PALETTE = [
  "#2f221c",
  "#4f7cff",
  "#23304d",
  "#f0c49f",
  "#111827",
  "#1f2937",
  "#b5766a",
] as const;

const DEFAULT_AVATAR_ROWS = [
  "................",
  "................",
  "................",
  "....00000000....",
  "....00333300....",
  "....00333300....",
  "....00333300....",
  ".....353335.....",
  ".....333333.....",
  "....11166111....",
  "....11111111....",
  "...1111111111...",
  "...1111111111...",
  "...1111111111...",
  "...1111111111...",
  "...1111111111...",
  "...1111111111...",
  "....11111111....",
  ".....22..22.....",
  ".....22..22.....",
  ".....22..22.....",
  ".....22..22.....",
  "....444..444....",
  "................",
] as const;

export const DEFAULT_AVATAR_PIXELS = DEFAULT_AVATAR_ROWS.join("");

export const DEFAULT_AVATAR: AvatarSpec = {
  version: AVATAR_VERSION,
  width: AVATAR_WIDTH,
  height: AVATAR_HEIGHT,
  palette: [...DEFAULT_AVATAR_PALETTE],
  pixels: DEFAULT_AVATAR_PIXELS,
};

/** A blank 16×24 canvas sharing the default palette. */
export function blankAvatar(): AvatarSpec {
  return {
    version: AVATAR_VERSION,
    width: AVATAR_WIDTH,
    height: AVATAR_HEIGHT,
    palette: [...DEFAULT_AVATAR_PALETTE],
    pixels: ".".repeat(AVATAR_PIXEL_COUNT),
  };
}

export function cloneAvatar(avatar: AvatarSpec): AvatarSpec {
  return {
    version: AVATAR_VERSION,
    width: AVATAR_WIDTH,
    height: AVATAR_HEIGHT,
    palette: [...avatar.palette],
    pixels: avatar.pixels,
  };
}

/** Returns the avatar when it satisfies the schema, otherwise `null`. */
export function normalizeAvatar(value: unknown): AvatarSpec | null {
  const parsed = avatarSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function avatarPixelIndexAt(
  avatar: AvatarSpec,
  x: number,
  y: number,
): number | null {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= AVATAR_WIDTH ||
    y >= AVATAR_HEIGHT
  ) {
    return null;
  }
  const char = avatar.pixels[y * AVATAR_WIDTH + x];
  if (!char || char === ".") {
    return null;
  }
  return Number.parseInt(char, 16);
}

export function avatarColorAt(
  avatar: AvatarSpec,
  x: number,
  y: number,
): string | null {
  const index = avatarPixelIndexAt(avatar, x, y);
  return index === null ? null : (avatar.palette[index] ?? null);
}

/** Non-transparent pixels as controlled rects for the SVG renderer. */
export function avatarRects(avatar: AvatarSpec): AvatarRect[] {
  const rects: AvatarRect[] = [];
  for (let index = 0; index < avatar.pixels.length; index += 1) {
    const char = avatar.pixels[index];
    if (!char || char === ".") {
      continue;
    }
    const color = avatar.palette[Number.parseInt(char, 16)];
    if (!color) {
      continue;
    }
    rects.push({
      x: index % AVATAR_WIDTH,
      y: Math.floor(index / AVATAR_WIDTH),
      color,
    });
  }
  return rects;
}

/** Editor/export format: canonical JSON, the only accepted sprite code. */
export function spriteCode(avatar: AvatarSpec): string {
  return JSON.stringify(
    {
      version: avatar.version,
      width: avatar.width,
      height: avatar.height,
      palette: avatar.palette,
      pixels: avatar.pixels,
    },
    null,
    2,
  );
}

export type SpriteCodeResult =
  | { ok: true; avatar: AvatarSpec }
  | { ok: false; errors: string[] };

/**
 * Parses pasted sprite code. It only ever runs `JSON.parse` + the schema —
 * pasted JavaScript/HTML is data and is rejected, never executed.
 */
export function parseSpriteCode(text: string): SpriteCodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["sprite code must be valid JSON"] };
  }
  const parsed = avatarSpecSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: formatAvatarIssues(parsed.error) };
  }
  return { ok: true, avatar: parsed.data };
}

/** Field-level messages, e.g. `pixels: pixels must be exactly 384 characters`. */
export function formatAvatarIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "<root>";
    return `${path}: ${issue.message}`;
  });
}

export interface AvatarDiff {
  changed: number;
  added: number;
  removed: number;
  paletteAdded: string[];
  paletteRemoved: string[];
  /** Unsaved sprite payload size in UTF-8 bytes. */
  bytes: number;
}

/** Pixel-level diff shown before an appearance save. */
export function avatarDiff(
  before: AvatarSpec | null,
  after: AvatarSpec | null,
): AvatarDiff {
  const left = before?.pixels ?? "";
  const right = after?.pixels ?? "";
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (let index = 0; index < AVATAR_PIXEL_COUNT; index += 1) {
    const from = left[index] ?? ".";
    const to = right[index] ?? ".";
    if (from === to) {
      continue;
    }
    changed += 1;
    if (from === ".") {
      added += 1;
    } else if (to === ".") {
      removed += 1;
    }
  }
  const beforePalette = new Set(before?.palette ?? []);
  const afterPalette = new Set(after?.palette ?? []);
  return {
    changed,
    added,
    removed,
    paletteAdded: [...afterPalette].filter(
      (color) => !beforePalette.has(color),
    ),
    paletteRemoved: [...beforePalette].filter(
      (color) => !afterPalette.has(color),
    ),
    bytes: after ? spriteCode(after).length : 0,
  };
}

/** UTF-8 byte size of the canonical sprite payload (budget check). */
export function spriteCodeBytes(avatar: AvatarSpec): number {
  return new TextEncoder().encode(spriteCode(avatar)).length;
}
