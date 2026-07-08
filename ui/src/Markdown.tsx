import { useMemo } from "react";
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { PROJECT_REPOS } from "./config";

// Matches, in priority order: a repo-relative file path (optionally with a
// ":<line>" suffix) or a standalone commit SHA (7-40 hex chars). Applied only
// to plain-text token leaves from the markdown parser, so fenced/inline code
// is never touched (those go through marked's separate code/codespan
// renderers, which we leave untouched).
const TOKEN_RE = new RegExp(
  "(?<path>\\b(?:src|scripts|tests|ui|docs|drizzle)\\/[\\w./-]+\\.(?:ts|tsx|js|md|json|sql|sh)(?::\\d+)?\\b)" +
    "|(?<sha>\\b[0-9a-f]{7,40}\\b)",
  "g",
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Autolinks a plain-text token. Runs on already-escaped text, so the
// generated markup is safe even before DOMPurify sees it.
function autolink(text: string, repo: string | undefined): string {
  const escaped = escapeHtml(text);
  return escaped.replace(TOKEN_RE, (match: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as { path?: string; sha?: string };
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

let linkHookInstalled = false;
function ensureLinkHook() {
  if (linkHookInstalled) return;
  linkHookInstalled = true;
  // Force every surviving <a> to open safely, regardless of what the
  // source markdown/HTML asked for.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer");
    }
  });
}
ensureLinkHook();

function renderMarkdown(text: string, projectKey: string): string {
  const repo = PROJECT_REPOS[projectKey];

  const renderer = new marked.Renderer();
  renderer.text = function (token: Tokens.Text | Tokens.Escape) {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    return autolink(token.text, repo);
  };

  const rawHtml = marked.parse(text, { gfm: true, breaks: true, renderer }) as string;

  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["iframe", "script", "style"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover"],
  });
}

export function Markdown({ text, projectKey }: { text: string; projectKey: string }) {
  const html = useMemo(() => renderMarkdown(text, projectKey), [text, projectKey]);
  // eslint-disable-next-line react/no-danger -- sanitized above via DOMPurify
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
