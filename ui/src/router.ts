import { useEffect, useState } from "react";

export type Route =
  | { view: "triage" }
  | { view: "board"; project: string }
  | { view: "issue"; ref: string }
  | { view: "review"; ref: string | null }
  | { view: "new-issue" };

// Fired whenever `navigate()` pushes a new history entry, so `useRoute` can
// re-render without a real `popstate` (which only fires on back/forward).
const NAVIGATE_EVENT = "switchyard:navigate";

// Remembers the last project key seen on the board route, so leaving the
// board (e.g. for triage) and clicking back on "Board" returns to the same
// project instead of falling back to whatever project happens to be first
// in the list. Persisted so it also survives a page reload.
const LAST_PROJECT_STORAGE_KEY = "switchyard:last-project";

export function getLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setLastProject(key: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, key);
  } catch {
    // Storage disabled (e.g. private browsing) — falls back to no memory.
  }
}

// Matches a pathname against a known route, or returns null for anything
// the client router doesn't own (used both to parse and to decide whether
// an internal anchor click should be intercepted).
function matchRoute(pathname: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { view: "triage" };
  if (parts[0] === "board" && parts.length === 2 && parts[1]) return { view: "board", project: parts[1] };
  if (parts[0] === "issue" && parts.length === 2 && parts[1]) return { view: "issue", ref: parts[1] };
  if (parts[0] === "review" && parts.length === 1) return { view: "review", ref: null };
  if (parts[0] === "review" && parts.length === 2 && parts[1]) return { view: "review", ref: parts[1] };
  if (parts[0] === "new" && parts.length === 1) return { view: "new-issue" };
  return null;
}

export function parsePath(pathname: string): Route {
  return matchRoute(pathname) ?? { view: "triage" };
}

export function isKnownPath(pathname: string): boolean {
  return matchRoute(pathname) !== null;
}

export function href(route: Route): string {
  if (route.view === "board") return `/board/${route.project}`;
  if (route.view === "issue") return `/issue/${route.ref}`;
  if (route.view === "review") return route.ref ? `/review/${route.ref}` : `/review`;
  if (route.view === "new-issue") return `/new`;
  return "/";
}

// Pushes a new history entry (real URL, no reload) and notifies listeners.
// Accepts either a Route or an already-resolved path (used by the anchor
// click interceptor in App.tsx, which only has the anchor's pathname).
export function navigate(target: Route | string): void {
  const path = typeof target === "string" ? target : href(target);
  if (path !== `${location.pathname}${location.search}`) {
    history.pushState(null, "", path);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

// Like `navigate`, but replaces the current history entry instead of pushing
// a new one — for redirects (e.g. bare `/review` to `/review/:ref`) where the
// bare path shouldn't become its own back-button stop.
export function redirect(target: Route | string): void {
  const path = typeof target === "string" ? target : href(target);
  if (path !== `${location.pathname}${location.search}`) {
    history.replaceState(null, "", path);
    window.dispatchEvent(new Event(NAVIGATE_EVENT));
  }
}

// Backward compat: old bookmarks/links use the `#/x/y` hash scheme. Rewrite
// them to the equivalent real path on first load, once, via history.replaceState
// (no navigation, no extra history entry).
let migrated = false;
function migrateHashRoute(): void {
  if (migrated) return;
  migrated = true;
  if (!location.hash.startsWith("#/")) return;
  const route = parsePath(location.hash.slice(1));
  history.replaceState(null, "", href(route));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => {
    migrateHashRoute();
    return parsePath(location.pathname);
  });
  useEffect(() => {
    const onChange = () => setRoute(parsePath(location.pathname));
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAVIGATE_EVENT, onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAVIGATE_EVENT, onChange);
    };
  }, []);
  useEffect(() => {
    if (route.view === "board") setLastProject(route.project);
  }, [route]);
  return route;
}
