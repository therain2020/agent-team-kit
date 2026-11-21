"use client";

import { PixelAgent } from "@/components/pixel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AVATAR_HEIGHT,
  AVATAR_MAX_PALETTE,
  AVATAR_PIXEL_COUNT,
  AVATAR_WIDTH,
  type AvatarSpec,
  DEFAULT_AVATAR,
  avatarColorAt,
  avatarDiff,
  cloneAvatar,
  parseSpriteCode,
  spriteCode,
  spriteCodeBytes,
} from "@kit/core/avatar";
import {
  Copy,
  Eraser,
  PaintBucket,
  Pencil,
  Pipette,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

type Tool = "pencil" | "eraser" | "fill" | "eyedropper";

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Pencil }> = [
  { id: "pencil", label: "toolPencil", icon: Pencil },
  { id: "eraser", label: "toolEraser", icon: Eraser },
  { id: "fill", label: "toolFill", icon: PaintBucket },
  { id: "eyedropper", label: "toolEyedropper", icon: Pipette },
];

interface Cell {
  x: number;
  y: number;
}

function sameAvatar(
  left: AvatarSpec | null,
  right: AvatarSpec | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cellIndex(cell: Cell): number {
  return cell.y * AVATAR_WIDTH + cell.x;
}

function charAt(avatar: AvatarSpec, cell: Cell): string {
  return avatar.pixels[cellIndex(cell)] ?? ".";
}

function withChar(avatar: AvatarSpec, cell: Cell, char: string): AvatarSpec {
  const index = cellIndex(cell);
  const pixels =
    avatar.pixels.slice(0, index) + char + avatar.pixels.slice(index + 1);
  return { ...avatar, pixels };
}

function floodFill(avatar: AvatarSpec, cell: Cell, char: string): AvatarSpec {
  const target = charAt(avatar, cell);
  if (target === char) {
    return avatar;
  }
  const pixels = avatar.pixels.split("");
  const queue: Cell[] = [cell];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    if (
      current.x < 0 ||
      current.y < 0 ||
      current.x >= AVATAR_WIDTH ||
      current.y >= AVATAR_HEIGHT
    ) {
      continue;
    }
    const index = cellIndex(current);
    if (seen.has(index) || pixels[index] !== target) {
      continue;
    }
    seen.add(index);
    pixels[index] = char;
    queue.push(
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    );
  }
  return { ...avatar, pixels: pixels.join("") };
}

function remapAfterColorRemoval(
  avatar: AvatarSpec,
  removedIndex: number,
): AvatarSpec {
  let pixels = "";
  for (const char of avatar.pixels) {
    if (char === ".") {
      pixels += ".";
      continue;
    }
    const index = Number.parseInt(char, 16);
    if (index === removedIndex) {
      pixels += ".";
    } else if (index > removedIndex) {
      pixels += (index - 1).toString(16);
    } else {
      pixels += char;
    }
  }
  return {
    ...avatar,
    palette: avatar.palette.filter((_, index) => index !== removedIndex),
    pixels,
  };
}

/**
 * Pixel avatar workbench (97 §3.4). Plain data in, plain data out: the editor
 * only ever serialises `AvatarSpec` JSON — no HTML, no script, no eval. Every
 * change is validated by the shared schema before it can reach the Pack.
 */
export function AvatarEditor({
  savedAvatar,
  manager,
  agentId,
  saving,
  onDraftChange,
  onSave,
}: {
  savedAvatar: AvatarSpec | null;
  manager: boolean;
  agentId: string;
  saving: boolean;
  onDraftChange: (avatar: AvatarSpec | null) => void;
  onSave: () => Promise<boolean>;
}) {
  const t = useTranslations("studio");
  const [baseline, setBaseline] = useState<AvatarSpec | null>(savedAvatar);
  const [working, setWorking] = useState<AvatarSpec>(
    savedAvatar ?? cloneAvatar(DEFAULT_AVATAR),
  );
  const [tool, setTool] = useState<Tool>("pencil");
  const [activeIndex, setActiveIndex] = useState(0);
  const [cursor, setCursor] = useState<Cell>({ x: 8, y: 12 });
  const [hover, setHover] = useState<Cell | null>(null);
  const [hexInput, setHexInput] = useState("#ffffff");
  const [spriteInput, setSpriteInput] = useState("");
  const [spriteErrors, setSpriteErrors] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [past, setPast] = useState<AvatarSpec[]>([]);
  const [future, setFuture] = useState<AvatarSpec[]>([]);
  const drawing = useRef(false);

  // Server truth changed (save + refresh, pack switch): rebaseline. The
  // parent passes the same object until the server payload actually changes.
  useEffect(() => {
    setBaseline(savedAvatar);
    setWorking(savedAvatar ?? cloneAvatar(DEFAULT_AVATAR));
    setPast([]);
    setFuture([]);
  }, [savedAvatar]);

  const dirty = !sameAvatar(baseline, working);
  const diff = avatarDiff(baseline, working);
  const readout = hover ?? cursor;
  const readoutIndex = avatarColorAt(working, readout.x, readout.y);
  const activeColor = working.palette[activeIndex] ?? "#000000";
  const active = Math.min(activeIndex, Math.max(working.palette.length - 1, 0));

  function commit(next: AvatarSpec) {
    setPast((current) => [...current.slice(-99), working]);
    setFuture([]);
    setWorking(next);
    onDraftChange(next);
  }

  function applyTool(cell: Cell, override?: Tool) {
    const activeTool = override ?? tool;
    if (activeTool === "eyedropper") {
      const picked = avatarColorAt(working, cell.x, cell.y);
      if (picked) {
        const index = working.palette.indexOf(picked);
        if (index >= 0) {
          setActiveIndex(index);
          setTool("pencil");
        }
      }
      return;
    }
    if (activeTool === "eraser") {
      commit(withChar(working, cell, "."));
      return;
    }
    if (activeTool === "fill") {
      commit(floodFill(working, cell, (active ?? 0).toString(16)));
      return;
    }
    commit(withChar(working, cell, active.toString(16)));
  }

  function cellFromPointer(
    event: ReactPointerEvent<SVGSVGElement>,
  ): Cell | null {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) {
      return null;
    }
    const x = Math.floor(
      ((event.clientX - bounds.left) / bounds.width) * AVATAR_WIDTH,
    );
    const y = Math.floor(
      ((event.clientY - bounds.top) / bounds.height) * AVATAR_HEIGHT,
    );
    if (x < 0 || y < 0 || x >= AVATAR_WIDTH || y >= AVATAR_HEIGHT) {
      return null;
    }
    return { x, y };
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const cell = cellFromPointer(event);
    if (!cell) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = tool === "pencil" || tool === "eraser";
    setCursor(cell);
    setHover(cell);
    applyTool(cell);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const cell = cellFromPointer(event);
    setHover(cell);
    if (drawing.current && cell) {
      setCursor(cell);
      applyTool(cell);
    }
  }

  function handlePointerUp() {
    drawing.current = false;
  }

  function moveCursor(dx: number, dy: number) {
    setCursor((current) => ({
      x: Math.min(AVATAR_WIDTH - 1, Math.max(0, current.x + dx)),
      y: Math.min(AVATAR_HEIGHT - 1, Math.max(0, current.y + dy)),
    }));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor(0, -1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCursor(0, 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveCursor(-1, 0);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveCursor(1, 0);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      applyTool(cursor);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < working.palette.length) {
        event.preventDefault();
        setActiveIndex(index);
      }
    }
  }

  function undo() {
    setPast((current) => {
      const previous = current[current.length - 1];
      if (!previous) {
        return current;
      }
      setFuture((next) => [working, ...next].slice(0, 100));
      setWorking(previous);
      onDraftChange(previous);
      return current.slice(0, -1);
    });
  }

  function redo() {
    setFuture((current) => {
      const next = current[0];
      if (!next) {
        return current;
      }
      setPast((previous) => [...previous.slice(-99), working]);
      setWorking(next);
      onDraftChange(next);
      return current.slice(1);
    });
  }

  function addColor() {
    const color = hexInput.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) {
      toast.error(t("appearanceHexInvalid"));
      return;
    }
    const existing = working.palette.indexOf(color);
    if (existing >= 0) {
      setActiveIndex(existing);
      return;
    }
    if (working.palette.length >= AVATAR_MAX_PALETTE) {
      toast.error(t("paletteFull"));
      return;
    }
    const next = { ...working, palette: [...working.palette, color] };
    commit(next);
    setActiveIndex(next.palette.length - 1);
  }

  function removeColor() {
    if (working.palette.length <= 1) {
      return;
    }
    const next = remapAfterColorRemoval(working, active);
    commit(next);
    setActiveIndex(Math.max(0, Math.min(active, next.palette.length - 1)));
  }

  function clearCanvas() {
    commit({ ...working, pixels: ".".repeat(AVATAR_PIXEL_COUNT) });
  }

  function loadDefault() {
    commit(cloneAvatar(DEFAULT_AVATAR));
    setActiveIndex(0);
  }

  function removeAvatar() {
    setPast([]);
    setFuture([]);
    setWorking(cloneAvatar(DEFAULT_AVATAR));
    onDraftChange(null);
  }

  async function copySprite() {
    try {
      await navigator.clipboard.writeText(spriteCode(working));
      toast.success(t("appearanceCopied"));
    } catch {
      toast.error(t("appearanceCopyFailed"));
    }
  }

  function importSprite() {
    const parsed = parseSpriteCode(spriteInput);
    if (!parsed.ok) {
      setSpriteErrors(parsed.errors);
      return;
    }
    setSpriteErrors([]);
    setImportOpen(false);
    setSpriteInput("");
    commit(cloneAvatar(parsed.avatar));
    setActiveIndex(0);
    toast.success(t("appearanceImported"));
  }

  async function saveAppearance() {
    const ok = await onSave();
    if (ok) {
      setBaseline(working);
      setPast([]);
      setFuture([]);
    }
  }

  return (
    <section
      aria-label={t("appearanceTitle")}
      className="space-y-3 rounded-md border border-border bg-zinc-950/40 p-3"
    >
      <div className="flex items-start gap-2">
        <Pencil className="mt-0.5 size-4 text-emerald-300" />
        <div>
          <h3 className="text-xs font-medium text-zinc-200">
            {t("appearanceTitle")}
          </h3>
          <p className="text-[10px] text-zinc-500">{t("appearanceHint")}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="space-y-2">
          <button
            type="button"
            onKeyDown={handleKeyDown}
            aria-label={t("appearanceCanvasLabel", {
              agent: agentId,
              x: readout.x,
              y: readout.y,
            })}
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter 1-9"
            className="block cursor-crosshair border border-px-line2 bg-px-ink p-0 shadow-px-sm outline-none focus-visible:border-px-accent"
          >
            <svg
              viewBox={`0 0 ${AVATAR_WIDTH} ${AVATAR_HEIGHT}`}
              width={192}
              height={288}
              role="img"
              aria-hidden="true"
              focusable="false"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={() => {
                setHover(null);
                drawing.current = false;
              }}
              className="block touch-none"
              shapeRendering="crispEdges"
            >
              <rect
                x="0"
                y="0"
                width={AVATAR_WIDTH}
                height={AVATAR_HEIGHT}
                fill="#0b0f17"
              />
              {working.pixels.split("").map((char, index) => {
                if (char === ".") {
                  return null;
                }
                const color = working.palette[Number.parseInt(char, 16)];
                if (!color) {
                  return null;
                }
                const x = index % AVATAR_WIDTH;
                const y = Math.floor(index / AVATAR_WIDTH);
                return (
                  <rect
                    key={`${x}-${y}`}
                    x={x}
                    y={y}
                    width="1"
                    height="1"
                    fill={color}
                  />
                );
              })}
              <rect
                x={readout.x}
                y={readout.y}
                width="1"
                height="1"
                fill="none"
                stroke="#34d399"
                strokeWidth="0.15"
              />
            </svg>
          </button>
          <p className="font-mono text-[10px] text-zinc-500" aria-live="polite">
            {t("appearanceReadout", {
              x: readout.x,
              y: readout.y,
              color: readoutIndex ?? t("appearanceTransparent"),
            })}
          </p>
          <p className="text-[10px] text-zinc-600">
            {t("appearanceShortcutHint")}
          </p>
          <div className="flex items-center gap-2 rounded border border-border/60 p-2">
            <PixelAgent
              seed={agentId.length}
              manager={manager}
              state="idle"
              tick={0}
              avatar={working}
            />
            <div className="min-w-0 text-[10px] text-zinc-500">
              <p className="text-zinc-300">{t("appearancePreview")}</p>
              <p>{t("appearanceBytes", { bytes: spriteCodeBytes(working) })}</p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              {t("appearanceTools")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TOOLS.map((entry) => {
                const Icon = entry.icon;
                return (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={tool === entry.id ? "default" : "outline"}
                    aria-pressed={tool === entry.id}
                    onClick={() => setTool(entry.id)}
                  >
                    <Icon className="size-3.5" />
                    {t(entry.label)}
                  </Button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              {t("appearancePalette", {
                count: working.palette.length,
                max: AVATAR_MAX_PALETTE,
              })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {working.palette.map((color, index) => (
                <button
                  key={color}
                  type="button"
                  aria-label={t("appearanceSwatch", { index, color })}
                  aria-pressed={active === index}
                  onClick={() => setActiveIndex(index)}
                  className="size-7 border-2 font-mono text-[9px] text-zinc-900"
                  style={{
                    backgroundColor: color,
                    borderColor: active === index ? "#34d399" : "#3f3f46",
                  }}
                >
                  {index + 1 <= 9 ? index + 1 : ""}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Input
                value={hexInput}
                onChange={(event) => setHexInput(event.target.value)}
                aria-label={t("appearanceHexLabel")}
                placeholder="#4f7cff"
                className="h-8 w-28 font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={addColor}
                disabled={working.palette.length >= AVATAR_MAX_PALETTE}
              >
                {t("appearanceAddColor")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={removeColor}
                disabled={working.palette.length <= 1}
              >
                <Trash2 className="size-3.5" />
                {t("appearanceRemoveColor")}
              </Button>
            </div>
            <p className="mt-1 font-mono text-[10px] text-zinc-500">
              {t("appearanceActiveColor", { color: activeColor })}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={undo}
              disabled={past.length === 0}
            >
              <Undo2 className="size-3.5" />
              {t("appearanceUndo")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={redo}
              disabled={future.length === 0}
            >
              <Redo2 className="size-3.5" />
              {t("appearanceRedo")}
            </Button>
            <Button size="sm" variant="outline" onClick={clearCanvas}>
              <Trash2 className="size-3.5" />
              {t("appearanceClear")}
            </Button>
            <Button size="sm" variant="outline" onClick={loadDefault}>
              <RotateCcw className="size-3.5" />
              {t("appearanceDefault")}
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copySprite()}
            >
              <Copy className="size-3.5" />
              {t("appearanceCopy")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setImportOpen((current) => !current)}
              aria-expanded={importOpen}
            >
              {t("appearancePaste")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={removeAvatar}
              disabled={!savedAvatar && !dirty}
            >
              {t("appearanceRemove")}
            </Button>
          </div>

          {importOpen ? (
            <div className="space-y-1.5 rounded-md border border-border/60 p-2">
              <Textarea
                value={spriteInput}
                onChange={(event) => {
                  setSpriteInput(event.target.value);
                  setSpriteErrors([]);
                }}
                placeholder={t("appearanceImportPlaceholder")}
                aria-label={t("appearanceImportLabel")}
                rows={6}
                className="font-mono text-[10px]"
              />
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={importSprite}>
                  {t("appearanceImport")}
                </Button>
                <span className="text-[10px] text-zinc-600">
                  {t("appearanceImportHint")}
                </span>
              </div>
              {spriteErrors.length > 0 ? (
                <ul className="space-y-0.5 text-[10px] text-red-300">
                  {spriteErrors.map((error) => (
                    <li key={error}>· {error}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5 rounded-md border border-border/60 p-2">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("appearanceDiffTitle")}
            </p>
            {dirty ? (
              <ul className="space-y-0.5 font-mono text-[10px] text-zinc-400">
                <li>
                  {t("appearanceDiffChanged", {
                    changed: diff.changed,
                    added: diff.added,
                    removed: diff.removed,
                  })}
                </li>
                <li>
                  {t("appearanceDiffPalette", {
                    added: diff.paletteAdded.join(", ") || "—",
                    removed: diff.paletteRemoved.join(", ") || "—",
                  })}
                </li>
              </ul>
            ) : (
              <p className="text-[10px] text-zinc-600">
                {t("appearanceDiffNone")}
              </p>
            )}
            <p className="text-[10px] text-zinc-600">
              {t("appearanceBudget", { bytes: spriteCodeBytes(working) })}
            </p>
            <Button
              size="sm"
              onClick={() => void saveAppearance()}
              disabled={saving || !dirty}
            >
              <Save className="size-3.5" />
              {saving ? t("appearanceSaving") : t("appearanceSave")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
