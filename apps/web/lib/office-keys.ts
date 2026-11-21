/**
 * Keyboard routes for the office and factory rooms (97 §3.3 工位动作, §3.5
 * 房间切换).
 *
 * Both rooms own one window-level `keydown` handler. The rules that decide
 * whether a keystroke is a shortcut — modal surfaces own the key, typing
 * targets own the key, modifier chords stay with the browser — live here as
 * pure functions so they can be tested without a DOM while the components stay
 * wired to a single contract.
 */

import { FACTORY_ROOM_HREF, officeRoomHref } from "./office-deeplink";

/** The subset of `KeyboardEvent` / React keyboard events the rules read. */
export interface KeyStroke {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** `event.target`, narrowed by `isTypingTarget`. */
  target?: unknown;
}

/** Inputs, textareas, selects and rich-text hosts own every printable key. */
export function isTypingTarget(target: unknown): boolean {
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
  } | null;
  if (!element) {
    return false;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable === true
  );
}

/** Chords (⌘/Ctrl/Alt) belong to the browser, never to a single-key shortcut. */
export function isPlainKey(event: KeyStroke): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

function isEligible(event: KeyStroke): boolean {
  return (
    !event.defaultPrevented &&
    isPlainKey(event) &&
    !isTypingTarget(event.target)
  );
}

/**
 * Office → factory (`F`, 97 §3.5). The mission dialog and the stage drawer own
 * the key while open, so a dialog never navigates the room underneath it.
 */
export function officeRoomShortcut(
  event: KeyStroke,
  options: { modalOpen?: boolean } = {},
): string | null {
  if (options.modalOpen || !isEligible(event)) {
    return null;
  }
  return event.key.toLowerCase() === "f" ? FACTORY_ROOM_HREF : null;
}

/**
 * Factory → office (`O`, 97 §3.5). Queue mode keeps `O` to itself, and an open
 * decision dialog owns the key. `href` carries the producer-station deep link
 * when the active workpiece knows one; otherwise the plain office floor.
 */
export function factoryRoomShortcut(
  event: KeyStroke,
  options: { href?: string; queueMode: boolean; dialogOpen?: boolean },
): string | null {
  if (options.dialogOpen || options.queueMode) {
    return null;
  }
  if (!isPlainKey(event) || isTypingTarget(event.target)) {
    return null;
  }
  return event.key.toLowerCase() === "o"
    ? (options.href ?? officeRoomHref())
    : null;
}

export type StationAction = "mission" | "run" | "approval";

/**
 * Agent-panel station actions (97 §3.3): `M` starts a mission, `R` opens the
 * run and `B` opens the approval. `R`/`B` only exist when the agent actually
 * has a run or approval to open.
 */
export function stationAction(
  event: KeyStroke,
  options: { hasRun: boolean; hasApproval: boolean },
): StationAction | null {
  if (!isEligible(event)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "m") {
    return "mission";
  }
  if (key === "r" && options.hasRun) {
    return "run";
  }
  if (key === "b" && options.hasApproval) {
    return "approval";
  }
  return null;
}

export type FloorKeyAction =
  | { kind: "step"; delta: -1 | 1 }
  | { kind: "open" }
  | { kind: "escape" }
  | null;

/**
 * Pixel-floor navigation (97 §3.1): `J`/`K` walk the roster, `Enter` opens the
 * selected station and `Escape` unlocks the camera. A suspended floor (stage
 * drawer open) ignores all four.
 */
export function floorKeyAction(
  event: KeyStroke,
  options: { suspended?: boolean; hasAgents: boolean; hasSelection: boolean },
): FloorKeyAction {
  if (options.suspended || !options.hasAgents || !isEligible(event)) {
    return null;
  }
  if (event.key === "j" || event.key === "J") {
    return { kind: "step", delta: 1 };
  }
  if (event.key === "k" || event.key === "K") {
    return { kind: "step", delta: -1 };
  }
  if (event.key === "Enter") {
    return options.hasSelection ? { kind: "open" } : null;
  }
  if (event.key === "Escape") {
    return { kind: "escape" };
  }
  return null;
}
