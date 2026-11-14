import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCny(value: number): string {
  if (!Number.isFinite(value)) {
    return "¥0.0000";
  }
  if (value === 0) {
    return "¥0";
  }
  if (Math.abs(value) < 0.01) {
    return `¥${value.toFixed(4)}`;
  }
  return `¥${value.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(
  startIso?: string,
  endIso?: string,
  locale = "en",
): string {
  if (!startIso) {
    return "—";
  }
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "—";
  }
  const seconds = Math.round((end - start) / 1000);
  if (locale === "zh") {
    if (seconds < 60) {
      return `${seconds} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) {
      return `${minutes} 分 ${rest} 秒`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function timeAgo(iso?: string, locale = "en"): string {
  if (!iso) {
    return locale === "zh" ? "未知" : "unknown";
  }
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return locale === "zh" ? "未知" : "unknown";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(
    locale === "zh" ? "zh-CN" : "en",
    { numeric: "auto" },
  );
  if (seconds < 60) {
    return formatter.format(-seconds, "second");
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return formatter.format(-minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatter.format(-hours, "hour");
  }
  return formatter.format(-Math.floor(hours / 24), "day");
}

export function timeUntil(iso?: string, locale = "en"): string {
  if (!iso) {
    return locale === "zh" ? "未知" : "unknown";
  }
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return locale === "zh" ? "未知" : "unknown";
  }
  const remaining = timestamp - Date.now();
  if (remaining <= 0) {
    return locale === "zh" ? "已过期" : "expired";
  }
  const formatter = new Intl.RelativeTimeFormat(
    locale === "zh" ? "zh-CN" : "en",
    { numeric: "auto" },
  );
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  if (minutes < 60) {
    return formatter.format(minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatter.format(hours, "hour");
  }
  return formatter.format(Math.floor(hours / 24), "day");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}…`;
}
