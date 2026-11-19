"use client";

import { cn } from "@/lib/utils";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { edgeStationId, rovingTabIndex, stepStationId } from "./station-nav";

interface StationApi {
  /** `0` for the active station, `-1` for the rest (roving tabindex). */
  tabIndex: 0 | -1;
  active: boolean;
  registerRef: (node: HTMLButtonElement | null) => void;
}

/**
 * Roving-tabindex station grid (97 §3.1).
 *
 * Only the active station participates in the tab order. Arrow keys move
 * selection and focus (wrapping at the ends), Home/End jump to the edges, and
 * Enter is left to the native button so it activates exactly like a click.
 * The render prop keeps the sprite/layout decisions with the caller while the
 * navigation rules stay in one place.
 */
export function StationGrid<T extends { id: string }>({
  items,
  activeId,
  onActivate,
  renderItem,
  className,
  itemClassName,
  label,
}: {
  items: readonly T[];
  activeId: string | null;
  onActivate: (id: string) => void;
  renderItem: (item: T, api: StationApi) => ReactNode;
  className?: string;
  itemClassName?: (item: T) => string | undefined;
  /** Accessible name for the group; stations carry their own labels. */
  label?: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const ids = useMemo(() => items.map((item) => item.id), [items]);

  const register = useCallback(
    (id: string) => (node: HTMLButtonElement | null) => {
      if (node) {
        refs.current.set(id, node);
      } else {
        refs.current.delete(id);
      }
    },
    [],
  );

  const move = useCallback(
    (nextId: string | null) => {
      if (!nextId) {
        return;
      }
      onActivate(nextId);
      refs.current.get(nextId)?.focus();
    },
    [onActivate],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(stepStationId(ids, activeId, 1));
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(stepStationId(ids, activeId, -1));
        break;
      case "Home":
        event.preventDefault();
        move(edgeStationId(ids, "first"));
        break;
      case "End":
        event.preventDefault();
        move(edgeStationId(ids, "last"));
        break;
      default:
        break;
    }
  };

  return (
    <fieldset
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("min-w-0 border-0 p-0 [display:grid] gap-3", className)}
    >
      {items.map((item, index) => (
        <div key={item.id} className={itemClassName?.(item)}>
          {renderItem(item, {
            tabIndex: rovingTabIndex(item.id, activeId, index),
            active: item.id === activeId,
            registerRef: register(item.id),
          })}
        </div>
      ))}
    </fieldset>
  );
}
