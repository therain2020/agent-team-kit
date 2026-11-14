import type { OnCallPolicy, QuietWindow } from "./models";

const FALLBACK_TIMEZONE = "UTC";

export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function timeOfDayInZone(now: Date, timezone: string): number {
  const zone = resolveTimezone(timezone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(
      parts.find((part) => part.type === "minute")?.value ?? 0,
    );
    const normalizedHour = hour === 24 ? 0 : hour;
    return normalizedHour * 60 + minute;
  } catch {
    const utc = new Intl.DateTimeFormat("en-US", {
      timeZone: FALLBACK_TIMEZONE,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const hour = Number(utc.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(
      utc.find((part) => part.type === "minute")?.value ?? 0,
    );
    return (hour === 24 ? 0 : hour) * 60 + minute;
  }
}

export function isWithinWindow(
  now: Date,
  window: Pick<QuietWindow, "start" | "end" | "timezone"> | null,
): boolean {
  if (!window) {
    return false;
  }
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  if (start === null || end === null || start === end) {
    return false;
  }
  const current = timeOfDayInZone(now, window.timezone);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function isNightMode(now: Date, policy: OnCallPolicy): boolean {
  return (
    policy.nightMode.enabled &&
    isWithinWindow(now, {
      start: policy.nightMode.start,
      end: policy.nightMode.end,
      timezone: policy.nightMode.timezone,
    })
  );
}

export function isQuietWindow(now: Date, policy: OnCallPolicy): boolean {
  return isWithinWindow(now, policy.quietWindow);
}

function resolveTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value) {
    return FALLBACK_TIMEZONE;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}
