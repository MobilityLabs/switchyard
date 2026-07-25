import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Actor, Project } from "./types";
import {
  ALL_SCOPE,
  getLastProject,
  href,
  isIssueRef,
  issueRoute,
  navigate,
  scopeProject,
  useRoute,
  type Route,
} from "./router";
import { logout, listIssues, listAgentSessions, listPendingActions } from "./api";
import { usePoll } from "./usePoll";

// Search box lives in the topbar so it's reachable from every view (SYD-86).
// "/" focuses it unless the user is already typing somewhere else; Enter
// either jumps straight to an issue ref (fast-path) or opens the current
// scope's /search?q=.
function SearchBox({ route, scope }: { route: Route; scope: string }) {
  const [query, setQuery] = useState(route.view === "search" ? route.query : "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Keeps the box in sync with the URL on back/forward navigation to /search,
  // without clobbering what the user is typing on every other view.
  useEffect(() => {
    if (route.view === "search") setQuery(route.query);
  }, [route]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function submit() {
    const trimmed = query.trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase();
    if (isIssueRef(upper)) navigate(issueRoute(upper));
    else navigate({ view: "search", scope, query: trimmed });
  }

  return (
    <input
      ref={inputRef}
      className="search-box"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
      }}
      placeholder="Search… (SYD-52, or a word) — press /"
    />
  );
}

export default function Shell(props: { me: Actor; projects: Project[]; children: ReactNode }) {
  const route = useRoute();
  // Below the header-collapse breakpoint the nav links move into a
  // disclosure menu toggled by this state (SYD-214); above the breakpoint
  // the CSS shows nav unconditionally regardless of navOpen.
  const [navOpen, setNavOpen] = useState(false);
  const lastProject = getLastProject();
  const allProjects = props.projects;

  const rememberedProject = allProjects.some((p) => p.key === lastProject) ? lastProject : null;
  // Every route except settings carries its scope in the URL (SYD-254);
  // settings is global, so its nav renders under the remembered scope.
  const scope = route.view === "settings" ? (rememberedProject ?? ALL_SCOPE) : route.scope;
  const scopeKey = scopeProject(scope);
  // The Board link always needs a concrete project: the current scope if it
  // has one, else the remembered project, else the first project.
  const boardProject = scopeKey ?? rememberedProject ?? allProjects[0]?.key ?? "";

  const inReview = usePoll(
    () => listIssues({ status: "in_review", project: scopeKey ?? undefined }),
    [scopeKey],
    30000,
  );
  const liveSessions = usePoll(() => listAgentSessions({ active: true }), [], 15000);
  const pendingApprovals = usePoll(() => listPendingActions("pending"), [], 15000);

  return (
    <>
      <header className="topbar">
        <span className="logo">⧉ Switchyard</span>
        <button
          type="button"
          className="menu-toggle"
          aria-label="Toggle navigation menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          ☰
        </button>
        {/* Below the header-collapse breakpoint this is a hidden disclosure
            menu toggled by menu-toggle above; any click inside closes it so
            picking a link doesn't leave the menu open (SYD-214). */}
        <nav className={navOpen ? "open" : undefined} onClick={() => setNavOpen(false)}>
          <a
            href={href({ view: "triage", scope })}
            className={route.view === "triage" ? "active" : ""}
          >
            Triage
          </a>
          <a
            href={
              boardProject
                ? href({ view: "board", scope: boardProject })
                : href({ view: "triage", scope: ALL_SCOPE })
            }
            className={route.view === "board" ? "active" : ""}
          >
            Board
          </a>
          <a
            href={href({ view: "review", scope, ref: null })}
            className={route.view === "review" ? "active" : ""}
          >
            Review
            {inReview.data && inReview.data.length > 0 && (
              <span className="badge">{inReview.data.length}</span>
            )}
          </a>
          <a
            href={href({ view: "agents", scope })}
            className={route.view === "agents" ? "active" : ""}
          >
            Agents
            {liveSessions.data && liveSessions.data.length > 0 && (
              <span className="badge">{liveSessions.data.length}</span>
            )}
          </a>
          <a
            href={href({ view: "approvals", scope })}
            className={route.view === "approvals" ? "active" : ""}
          >
            Approvals
            {pendingApprovals.data && pendingApprovals.data.length > 0 && (
              <span className="badge warn">{pendingApprovals.data.length}</span>
            )}
          </a>
          {props.me.type === "human" && (
            <a
              href={href({ view: "settings", tab: "projects" })}
              className={route.view === "settings" ? "active" : ""}
            >
              Settings
            </a>
          )}
        </nav>
        <SearchBox route={route} scope={scope} />
        {route.view !== "settings" && (
          <select
            value={scopeKey ?? ""}
            onChange={(e) => {
              const next = e.target.value || ALL_SCOPE;
              // Board and issue views need a concrete project. An issue's
              // scope is pinned to its ref, so switching projects there goes
              // to the target project's board — the nearest "keep browsing
              // that project" surface. Review drops the selected ref: it
              // belongs to the scope being left.
              if (route.view === "issue") {
                navigate(
                  next === ALL_SCOPE
                    ? { view: "triage", scope: ALL_SCOPE }
                    : { view: "board", scope: next },
                );
              } else if (route.view === "board") {
                navigate({ view: "board", scope: e.target.value });
              } else if (route.view === "review") {
                navigate({ view: "review", scope: next, ref: null });
              } else if (route.view === "search") {
                navigate({ view: "search", scope: next, query: route.query });
              } else {
                navigate({ ...route, scope: next });
              }
            }}
          >
            {route.view !== "board" && route.view !== "issue" && (
              <option value="">All projects</option>
            )}
            {allProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button className="primary" onClick={() => navigate({ view: "new-issue", scope })}>
          + New issue
        </button>
        <span className="badge actor">{props.me.name}</span>
        <button onClick={() => logout().then(() => location.reload())}>Log out</button>
      </header>
      <div className="content">{props.children}</div>
    </>
  );
}
