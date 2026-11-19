"use client";

import type { ActivityEvent } from "@kit/activity";
import { useEffect, useRef, useState } from "react";

export type PixelLiveStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

/**
 * One SSE subscription to the activity stream for the pixel surfaces.
 *
 * The handler is kept in a ref so reconnects never restart because a parent
 * re-rendered; the stream resumes from the last `event_id` via `Last-Event-ID`
 * handled by the browser's EventSource. Motion only ever runs in response to
 * frames delivered here — when the stream is quiet, so is the scene.
 */
export function usePixelLive({
  onEvent,
  enabled = true,
}: {
  onEvent: (event: ActivityEvent) => void;
  enabled?: boolean;
}): PixelLiveStatus {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const [status, setStatus] = useState<PixelLiveStatus>("connecting");

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setStatus("offline");
      return;
    }

    let source: EventSource | null = null;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }
      const opened = new EventSource("/api/activity/stream?live=1");
      source = opened;
      setStatus((current) => (current === "live" ? current : "connecting"));

      opened.addEventListener("open", () => {
        if (!disposed) {
          setStatus("live");
        }
      });
      opened.addEventListener("activity", (message) => {
        try {
          const parsed = JSON.parse(
            (message as MessageEvent<string>).data,
          ) as ActivityEvent;
          handlerRef.current(parsed);
        } catch {
          // Malformed frames are ignored; the stream keeps running.
        }
      });
      opened.addEventListener("error", () => {
        if (disposed) {
          return;
        }
        setStatus("reconnecting");
        opened.close();
        source = null;
        // EventSource retries on its own only until the connection errors;
        // reopen explicitly so a restarted web process recovers.
        retry = setTimeout(connect, 3000);
      });
    };

    connect();

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (!source || source.readyState === EventSource.CLOSED) {
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (retry) {
        clearTimeout(retry);
      }
      source?.close();
    };
  }, [enabled]);

  return status;
}
