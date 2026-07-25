import { useEffect, useState } from "react";
import { projectKeyFromRef } from "./refs";

export const SETTINGS_TABS = ["projects", "actors", "integrations", "config"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

// SYD-254: scope-first routing. The first path segment of every route except
// /settings is the scope — a concrete project key ("SYD") or this reserved
// lowercase word for cross-project views. Board always needs a concrete key
// (a kanban mixing projects' columns has no meaning), and an issue route's
// scope is always its ref's own project.
export const ALL_SCOPE = "all";

export type Route =
  | { view: "triage"; scope: string }
  | { view: "board"; scope: string }
  | { view: "issue"; scope: string; ref: string }
  | { view: "review"; scope: string; ref: string | null }
  | { view: "new-issue"; scope: string }
  | { view: "search"; scope: string; query: string }
  | { view: "agents"; scope: string }
  | { view: "approvals"; scope: string }
  | { view: "settings"; tab: SettingsTab };

// Matches a project key (e.g. "SYD"), as opposed to an issue ref like
// "SYD-66" (per-issue selection keys off the "-NUMBER" suffix). Keys are
// uppercase, so the lowercase ALL_SCOPE and view words can't collide.
const PROJECT_KEY_PATTERN = /^[A-Z]{2,10}$/;
export function isProjectKey(value: string): boolean {
  return PROJECT_KEY_PATTERN.test(value);
}

// Matches an issue ref like "SYD-66". A ref always names its own project,
// which is why issue routes derive their scope from the ref instead of
// trusting the scope segment (see issueRoute / matchScoped).
const ISSUE_REF_PATTERN = /^[A-Z]{2,10}-\d+$/;
export function isIssueRef(value: string): boolean {
  return ISSUE_REF_PATTERN.test(value);
}

// The concrete project a scope names, or null for the cross-project scope —
// the shape the API's `project` filters and view props want.
export function scopeProject(scope: string): string | null {
  return scope === ALL_SCOPE ? null : scope;
}

// The one way to build an issue route: the scope comes from the ref, so a
// caller can't construct a mismatched pair.
export function issueRoute(ref: string): Route {
  return { view: "issue", scope: projectKeyFromRef(ref), ref };
}

function isScopeSegment(value: string): boolean {
  return value === ALL_SCOPE || isProjectKey(value);
}

// Fired whenever `navigate()` pushes a new history entry, so `useRoute` can
// re-render without a real `popstate` (which only fires on back/forward).
const NAVIGATE_EVENT = "switchyard:navigate";

// Remembers the last concrete project scope seen on any scoped view, so bare
// "/" and the Board nav link from an all-scope view return to the project you
// were working in instead of falling back to whatever project happens to be
// first in the list. Persisted so it also survives a page reload (SYD-55).
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

function defaultRoute(): Route {
  return { view: "triage", scope: getLastProject() ?? ALL_SCOPE };
}

// Scope-first shapes: /:scope/<view>[/:arg]
function matchScoped(parts: string[], search: string): Route | null {
  const [scope, view, arg] = parts;
  if (!scope || !isScopeSegment(scope)) return null;
  if (view === "triage" && parts.length === 2) return { view: "triage", scope };
  if (view === "board" && parts.length === 2 && scope !== ALL_SCOPE) {
    return { view: "board", scope };
  }
  // The ref names its own project; a disagreeing scope segment (or "all") is
  // corrected here — the ref wins — and useRoute canonicalizes the URL.
  if (view === "issue" && parts.length === 3 && isIssueRef(arg)) return issueRoute(arg);
  if (view === "review") {
    if (parts.length === 2) return { view: "review", scope, ref: null };
    if (parts.length === 3 && isIssueRef(arg)) return { view: "review", scope, ref: arg };
    return null;
  }
  if (view === "new" && parts.length === 2) return { view: "new-issue", scope };
  if (view === "search" && parts.length === 2) {
    return { view: "search", scope, query: new URLSearchParams(search).get("q") ?? "" };
  }
  if (view === "agents" && parts.length === 2) return { view: "agents", scope };
  if (view === "approvals" && parts.length === 2) return { view: "approvals", scope };
  return null;
}

// Pre-SYD-254 view-first shapes: old bookmarks, and issue/board links written
// into markdown comments before the switch. Parsed to the same Route values
// as their scope-first equivalents; useRoute rewrites the address bar.
function matchLegacy(parts: string[], search: string): Route | null {
  const [head, arg] = parts;
  if (head === "board" && parts.length === 2 && isProjectKey(arg)) {
    return { view: "board", scope: arg };
  }
  if (head === "issue" && parts.length === 2 && isIssueRef(arg)) return issueRoute(arg);
  if (head === "triage") {
    if (parts.length === 1) return { view: "triage", scope: ALL_SCOPE };
    if (parts.length === 2 && isProjectKey(arg)) return { view: "triage", scope: arg };
    return null;
  }
  if (head === "review") {
    if (parts.length === 1) return { view: "review", scope: ALL_SCOPE, ref: null };
    if (parts.length === 2 && isProjectKey(arg)) return { view: "review", scope: arg, ref: null };
    if (parts.length === 2 && isIssueRef(arg)) {
      return { view: "review", scope: projectKeyFromRef(arg), ref: arg };
    }
    return null;
  }
  if (head === "search" && parts.length === 1) {
    return { view: "search", scope: ALL_SCOPE, query: new URLSearchParams(search).get("q") ?? "" };
  }
  if (head === "new" && parts.length === 1) return { view: "new-issue", scope: ALL_SCOPE };
  if (head === "agents" && parts.length === 1) return { view: "agents", scope: ALL_SCOPE };
  if (head === "approvals" && parts.length === 1) return { view: "approvals", scope: ALL_SCOPE };
  return null;
}

// Matches a pathname (plus its query string, needed only by /search) against
// a known route, or returns null for anything the client router doesn't own
// (used both to parse and to decide whether an internal anchor click should
// be intercepted).
function matchRoute(pathname: string, search: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return defaultRoute();
  if (parts[0] === "settings") {
    if (parts.length === 1) return { view: "settings", tab: "projects" };
    if (parts.length === 2 && (SETTINGS_TABS as readonly string[]).includes(parts[1])) {
      return { view: "settings", tab: parts[1] as SettingsTab };
    }
    return null;
  }
  return matchScoped(parts, search) ?? matchLegacy(parts, search);
}

export function parsePath(pathname: string, search = ""): Route {
  return matchRoute(pathname, search) ?? defaultRoute();
}

export function isKnownPath(pathname: string): boolean {
  return matchRoute(pathname, "") !== null;
}

export function href(route: Route): string {
  if (route.view === "settings") {
    return route.tab === "projects" ? "/settings" : `/settings/${route.tab}`;
  }
  if (route.view === "board") return `/${route.scope}/board`;
  if (route.view === "issue") return `/${route.scope}/issue/${route.ref}`;
  if (route.view === "triage") return `/${route.scope}/triage`;
  if (route.view === "review") {
    return route.ref ? `/${route.scope}/review/${route.ref}` : `/${route.scope}/review`;
  }
  if (route.view === "new-issue") return `/${route.scope}/new`;
  if (route.view === "search") {
    return route.query
      ? `/${route.scope}/search?q=${encodeURIComponent(route.query)}`
      : `/${route.scope}/search`;
  }
  if (route.view === "agents") return `/${route.scope}/agents`;
  if (route.view === "approvals") return `/${route.scope}/approvals`;
  return `/${ALL_SCOPE}/triage`;
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
// a new one — for redirects (legacy shapes, bare "/", ref-vs-scope
// mismatches) where the non-canonical path shouldn't become its own
// back-button stop.
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
    return parsePath(location.pathname, location.search);
  });
  useEffect(() => {
    const onChange = () => setRoute(parsePath(location.pathname, location.search));
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAVIGATE_EVENT, onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAVIGATE_EVENT, onChange);
    };
  }, []);
  // Legacy shapes, bare "/", and ref-vs-scope mismatches all parse to a route
  // whose canonical href differs from the address bar. Replace, never push —
  // the non-canonical form must not become a back-button stop. Stable after
  // one pass: the replaced URL parses back to the same route.
  useEffect(() => {
    const canonical = href(route);
    if (canonical !== `${location.pathname}${location.search}`) redirect(canonical);
  }, [route]);
  useEffect(() => {
    const project = route.view === "settings" ? null : scopeProject(route.scope);
    if (project) setLastProject(project);
  }, [route]);
  return route;
}
