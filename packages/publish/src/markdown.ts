import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));

md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, index, options, env, self);
};

md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = String(token?.attrGet("src") ?? "");
  const alt = String(token?.content ?? "");
  return `<a href="${escapeAttribute(src)}" target="_blank" rel="noreferrer noopener">${escapeText(alt || src)}</a>`;
};

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

export interface TitleSummary {
  title: string;
  summary: string;
}

export function extractTitleSummary(markdown: string): TitleSummary {
  const lines = markdown.split(/\r?\n/);
  let title = "";
  let titleIndex = -1;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) {
      continue;
    }
    if (/^\|/.test(line) || /^([-*_])\1{2,}$/.test(line)) {
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading?.[1]) {
      title = stripInlineMarkdown(heading[1]);
      titleIndex = index;
      break;
    }
    title = stripInlineMarkdown(line);
    titleIndex = index;
    break;
  }

  if (!title) {
    return { title: "", summary: "" };
  }

  const paragraph: string[] = [];
  inFence = false;
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("```")) {
      if (paragraph.length > 0) {
        break;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!line) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (/^#{1,6}\s+/.test(line) || /^([-*_])\1{2,}$/.test(line)) {
      break;
    }
    if (/^\|/.test(line)) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    const cleaned = line.replace(/^>\s?/, "").replace(/^([-*+]|\d+\.)\s+/, "");
    paragraph.push(cleaned);
  }

  const summary = stripInlineMarkdown(paragraph.join(" "))
    .replaceAll("|", " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: truncate(title, 92),
    summary: truncate(summary, 220),
  };
}

export function stripLeadingHeading(markdown: string, title: string): string {
  const lines = markdown.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) {
    return markdown;
  }
  const heading = lines[index]?.match(/^#{1,3}\s+(.+)$/);
  if (!heading?.[1] || stripInlineMarkdown(heading[1]) !== title) {
    return markdown;
  }
  lines.splice(index, 1);
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
  return lines.join("\n");
}

export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

export function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll("'", "&#39;");
}
