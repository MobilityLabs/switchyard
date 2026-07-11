const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// Client-side scheme guard for raw anchor hrefs (SYD-133). React doesn't
// block javascript:/data: hrefs on its own — the server validates
// provenance URLs are http(s) (src/services/issues.ts), but PR/webhook
// urls stored in event payloads aren't, so this is applied independently
// of any single server invariant.
export function isSafeUrl(url: string): boolean {
  try {
    return SAFE_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Returns the url unchanged if it passes the scheme allow-list, otherwise
// undefined so React omits the href attribute entirely (renders an inert
// link rather than a clickable one).
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return isSafeUrl(url) ? url : undefined;
}
