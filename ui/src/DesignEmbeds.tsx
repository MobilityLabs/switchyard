import { useState } from "react";

const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;

type EmbedKind = "figma" | "paper";

type Embed = { url: string; kind: EmbedKind };

export function classify(url: string): EmbedKind | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "figma.com" && /^\/(file|design|proto|board)\//.test(u.pathname)) return "figma";
    if (host === "paper.design") return "paper";
    return null;
  } catch {
    return null;
  }
}

export function extractEmbeds(text: string): Embed[] {
  const seen = new Set<string>();
  const embeds: Embed[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    const kind = classify(url);
    if (!kind) continue;
    seen.add(url);
    embeds.push({ url, kind });
  }
  return embeds;
}

const KIND_LABEL: Record<EmbedKind, string> = { figma: "Figma", paper: "Paper" };

export function DesignEmbeds({ text }: { text: string }) {
  const embeds = extractEmbeds(text);
  if (embeds.length === 0) return null;
  return (
    <div className="design-embeds">
      {embeds.map((embed) => (
        <DesignEmbedCard key={embed.url} embed={embed} />
      ))}
    </div>
  );
}

function DesignEmbedCard({ embed }: { embed: Embed }) {
  const [expanded, setExpanded] = useState(false);

  // These iframes are only ever built from URLs extracted above and matched
  // against the figma.com / paper.design allowlist — never from raw user
  // HTML, which the markdown sanitizer forbids from containing iframes at all.
  const src =
    embed.kind === "figma"
      ? `https://www.figma.com/embed?embed_host=switchyard&url=${encodeURIComponent(embed.url)}`
      : // paper.design has no embed endpoint; we frame the URL directly. If the
        // target sends X-Frame-Options/CSP frame-ancestors that refuse framing,
        // the iframe will just show blank — the card's link above still works.
        embed.url;

  return (
    <article className="design-embed panel">
      <header>
        <span className={`design-embed-label design-embed-${embed.kind}`}>
          {KIND_LABEL[embed.kind]}
        </span>
        <a href={embed.url} target="_blank" rel="noreferrer">
          {embed.url}
        </a>
        <button onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide preview" : "Show preview"}
        </button>
      </header>
      {expanded && (
        <iframe
          className="design-embed-frame"
          src={src}
          loading="lazy"
          title={`${KIND_LABEL[embed.kind]} preview`}
          // Defense-in-depth if the embedded origin is ever compromised:
          // scripts/storage/popups are what the embeds need to function,
          // everything else (top navigation, forms, downloads) stays blocked.
          sandbox="allow-scripts allow-same-origin allow-popups"
          allowFullScreen
        />
      )}
    </article>
  );
}
