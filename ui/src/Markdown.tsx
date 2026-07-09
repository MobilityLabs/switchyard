import { useMemo } from "react";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { PROJECT_REPOS } from "./config";

// Matches, in priority order: a repo-relative file path (optionally with a
// ":<line>" suffix), a standalone commit SHA (7-40 hex chars), or an
// @mention (word chars plus "./-" so actor names like "claude/dev" match).
// Applied only to plain-text token leaves from the markdown parser, so
// fenced/inline code is never touched (those go through marked's separate
// code/codespan renderers, which we leave untouched).
const TOKEN_RE = new RegExp(
  "(?<path>\\b(?:src|scripts|tests|ui|docs|drizzle)\\/[\\w./-]+\\.(?:ts|tsx|js|md|json|sql|sh)(?::\\d+)?\\b)" +
    "|(?<sha>\\b[0-9a-f]{7,40}\\b)" +
    "|@(?<mention>[A-Za-z0-9_]+(?:[./-][A-Za-z0-9_]+)*)",
  "g",
);

// Convention (SYD-56): a comment whose body leads with "@agent" (case
// insensitive) summons an answerer session — mirrors AGENT_QUESTION_RE in
// src/services/comments.ts.
const LEADING_AGENT_RE = /^@agent\b/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Autolinks and mention-highlights a plain-text token. Runs on
// already-escaped text, so the generated markup is safe even before
// DOMPurify sees it. `knownMentions` is a lowercased set of highlightable
// @targets (the literal "agent" keyword plus known actor names) — anything
// else is left as plain text, per SYD-57. `leadingSlot` is true only while
// processing the very first text leaf of the document, so the leading
// "@agent" summons (and only that occurrence) can get the stronger style.
function autolink(
  text: string,
  repo: string | undefined,
  knownMentions: Set<string>,
  leadingSlot: boolean,
): string {
  const escaped = escapeHtml(text);
  return escaped.replace(TOKEN_RE, (match: string, ...rest: unknown[]) => {
    // rest is [...positionalGroups, offset, fullString, namedGroups] — named
    // capture groups are also numbered, so offset sits three from the end,
    // not at rest[0].
    const offset = rest[rest.length - 3] as number;
    const groups = rest[rest.length - 1] as { path?: string; sha?: string; mention?: string };
    if (groups.path) {
      const lineMatch = /^(.*):(\d+)$/.exec(groups.path);
      const linkPath = lineMatch ? lineMatch[1] : groups.path;
      const line = lineMatch ? lineMatch[2] : undefined;
      if (!repo) return `<code>${groups.path}</code>`;
      const href = `${repo}/blob/main/${linkPath}${line ? `#L${line}` : ""}`;
      return `<a href="${href}"><code>${groups.path}</code></a>`;
    }
    if (groups.sha) {
      if (!repo) return `<code>${groups.sha}</code>`;
      return `<a href="${repo}/commit/${groups.sha}"><code>${groups.sha}</code></a>`;
    }
    if (groups.mention) {
      const lower = groups.mention.toLowerCase();
      if (!knownMentions.has(lower)) return match;
      const isLeadingAgent = leadingSlot && offset === 0 && lower === "agent";
      const cls = isLeadingAgent ? "mention mention-lead" : "mention";
      return `<span class="${cls}">@${groups.mention}</span>`;
    }
    return match;
  });
}

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "del", "s",
  "blockquote", "ul", "ol", "li",
  "code", "pre", "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "input", "span",
];
const ALLOWED_ATTR = ["href", "target", "rel", "src", "alt", "title", "class", "checked", "disabled", "type", "start"];

// Matches only our own attachment-serving URLs: a same-origin relative path
// with no extra path segments, query, or scheme — so it can't be smuggled
// into a protocol-relative ("//host/...") or absolute external URL.
const ATTACHMENT_SRC_RE = /^\/api\/attachments\/\d+\/[\w.-]+$/;
const ATTACHMENT_VIDEO_HREF_RE = /^\/api\/attachments\/\d+\/[\w.-]+\.(mp4|webm|mov)$/i;

let hooksInstalled = false;
function ensureHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // Force every surviving <a> to open safely, regardless of what the
  // source markdown/HTML asked for.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer");
    }
    // Images are only allowed to load from our own attachment-serving route.
    // Anything else (including protocol-relative/external hosts) is dropped
    // and swapped for a plain link — undisplayed <img src> is a classic
    // tracking-pixel/read-receipt vector, so we never let one auto-fetch.
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!ATTACHMENT_SRC_RE.test(src)) {
        const link = node.ownerDocument.createElement("a");
        link.setAttribute("href", src || "#");
        link.textContent = node.getAttribute("alt") || src || "image";
        node.replaceWith(link);
      }
    }
  });
  // <input> is allowlisted only for GFM task-list checkboxes; pin every
  // surviving input to a disabled checkbox so raw HTML can't render text
  // fields or other UI-spoofing input types.
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "input" && node instanceof Element) {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
  });
}
ensureHooks();

// Adds a real <video> element below any link that points at an
// attachment-served mp4/webm/mov. Built with the DOM API directly, after
// DOMPurify has already run, rather than by allowing <video> through the
// sanitizer — the sanitizer config still forbids video/iframe in arbitrary
// user HTML, so this is the only path a <video> tag can reach the page.
function attachVideoPreviews(container: HTMLElement): void {
  for (const a of Array.from(container.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (!ATTACHMENT_VIDEO_HREF_RE.test(href)) continue;
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = href;
    a.insertAdjacentElement("afterend", video);
  }
}

export function renderMarkdown(
  text: string,
  projectKey: string,
  knownActorNames: readonly string[] = [],
): string {
  const repo = PROJECT_REPOS[projectKey];
  const knownMentions = new Set(knownActorNames.map((n) => n.toLowerCase()));
  knownMentions.add("agent");
  const leadingAgent = LEADING_AGENT_RE.test(text.trimStart());
  let firstLeafSeen = false;

  const renderer = new marked.Renderer();
  renderer.text = function (token: Tokens.Text | Tokens.Escape) {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    const isLeadingSlot = leadingAgent && !firstLeafSeen;
    firstLeafSeen = true;
    return autolink(token.text, repo, knownMentions, isLeadingSlot);
  };

  const rawHtml = marked.parse(text, { gfm: true, breaks: true, renderer }) as string;

  const sanitized = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["iframe", "script", "style"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover"],
  });

  const container = document.createElement("div");
  container.innerHTML = sanitized;
  attachVideoPreviews(container);
  return container.innerHTML;
}

export function Markdown({
  text,
  projectKey,
  knownActorNames = [],
}: {
  text: string;
  projectKey: string;
  knownActorNames?: readonly string[];
}) {
  const html = useMemo(
    () => renderMarkdown(text, projectKey, knownActorNames),
    [text, projectKey, knownActorNames],
  );
  // eslint-disable-next-line react/no-danger -- sanitized above via DOMPurify
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
