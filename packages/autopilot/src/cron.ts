export interface ZonedParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

export function nextCronOccurrence(
  expression: string,
  after: Date,
  timezone = "UTC",
): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron must have five fields");
  }
  const minute = parseField(fields[0] ?? "");
  const hour = parseField(fields[1] ?? "");
  const day = parseField(fields[2] ?? "");
  const month = parseField(fields[3] ?? "");
  const weekday = parseField(fields[4] ?? "");
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  const start = new Date(after.getTime() + 60_000);
  start.setSeconds(0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (let index = 0; index < 370 * 24 * 60; index += 1) {
    const candidate = new Date(start.getTime() + index * 60_000);
    const parts = formatter.formatToParts(candidate);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const zoned: ZonedParts = {
      minute: Number(get("minute")),
      hour: Number(get("hour")),
      day: Number(get("day")),
      month: Number(get("month")),
      weekday: weekdayMap[get("weekday")] ?? 0,
    };

    if (
      !minute.has(zoned.minute) ||
      !hour.has(zoned.hour) ||
      !month.has(zoned.month)
    ) {
      continue;
    }
    const domMatch = day.has(zoned.day);
    const dowMatch =
      weekday.has(zoned.weekday) || (zoned.weekday === 0 && weekday.has(7));
    const dayMatch =
      domRestricted && dowRestricted
        ? domMatch || dowMatch
        : domMatch && dowMatch;
    if (dayMatch) {
      return candidate;
    }
  }

  throw new Error("no cron occurrence found within 370 days");
}

function parseField(value: string): Set<number> {
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }
    const [rangePart, stepPart] = token.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step: ${token}`);
    }
    const bounds = rangePart ?? "*";
    let start: number;
    let end: number;
    if (bounds === "*") {
      start = 0;
      end = 59;
    } else if (bounds.includes("-")) {
      const [rawStart, rawEnd] = bounds.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(bounds);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error(`invalid cron field: ${token}`);
    }
    for (let value = start; value <= end; value += step) {
      result.add(value);
    }
  }
  if (result.size === 0) {
    throw new Error("empty cron field");
  }
  return result;
}
