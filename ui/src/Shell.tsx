import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Actor, Project } from "./types";
import { getLastProject, href, isIssueRef, navigate, useRoute, type Route } from "./router";
import { logout, listIssues, listAgentSessions, listPendingActions } from "./api";
import { usePoll } from "./usePoll";

// Search box lives in the topbar so it's reachable from every view (SYD-86).
// "/" focuses it unless the user is already typing somewhere else; Enter
// either jumps straight to an issue ref (fast-path) or opens /search?q=.
function SearchBox({ route }: { route: Route }) {
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
    if (isIssueRef(upper)) navigate({ view: "issue", ref: upper });
    else navigate({ view: "search", query: trimmed });
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
  const currentProject =
    route.view === "board" ? route.project : (rememberedProject ?? allProjects[0]?.key ?? "");

  // Scopes the Review nav badge to whatever project context is active: the
  // route's own project when it carries one, else the SYD-55 remembered
  // project, else unscoped ("All projects").
  const scopeProject: string | null =
    route.view === "triage" || route.view === "review" ? route.project : rememberedProject;
  const inReview = usePoll(
    () => listIssues({ status: "in_review", project: scopeProject ?? undefined }),
    [scopeProject],
    30000,
  );
  const liveSessions = usePoll(() => listAgentSessions({ active: true }), [], 15000);
  const pendingApprovals = usePoll(() => listPendingActions("pending"), [], 15000);

  // Triage/Review tabs default to the last project you were looking at
  // (SYD-55) rather than always landing on "All projects" — but a bare
  // /triage or /review URL (an old bookmark, a fresh link) still means
  // "All projects", so this only shapes the nav link target, not routing.
  const triageHref =
    route.view === "triage" ? href(route) : href({ view: "triage", project: rememberedProject });
  const reviewHref =
    route.view === "review"
      ? href(route)
      : href({ view: "review", project: rememberedProject, ref: null });

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
          <a href={triageHref} className={route.view === "triage" ? "active" : ""}>
            Triage
          </a>
          <a
            href={
              currentProject
                ? href({ view: "board", project: currentProject })
                : href({ view: "triage", project: null })
            }
            className={route.view === "board" ? "active" : ""}
          >
            Board
          </a>
          <a href={reviewHref} className={route.view === "review" ? "active" : ""}>
            Review
            {inReview.data && inReview.data.length > 0 && (
              <span className="badge">{inReview.data.length}</span>
            )}
          </a>
          <a href={href({ view: "agents" })} className={route.view === "agents" ? "active" : ""}>
            Agents
            {liveSessions.data && liveSessions.data.length > 0 && (
              <span className="badge">{liveSessions.data.length}</span>
            )}
          </a>
          <a
            href={href({ view: "approvals" })}
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
        <SearchBox route={route} />
        {(route.view === "board" || route.view === "triage" || route.view === "review") && (
          <select
            value={route.view === "board" ? route.project : (route.project ?? "")}
            onChange={(e) => {
              if (route.view === "board") navigate({ view: "board", project: e.target.value });
              else if (route.view === "triage")
                navigate({ view: "triage", project: e.target.value || null });
              else navigate({ view: "review", project: e.target.value || null, ref: null });
            }}
          >
            {route.view !== "board" && <option value="">All projects</option>}
            {allProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button className="primary" onClick={() => navigate({ view: "new-issue" })}>
          + New issue
        </button>
        <span className="badge actor">{props.me.name}</span>
        <button onClick={() => logout().then(() => location.reload())}>Log out</button>
      </header>
      <div className="content">{props.children}</div>
    </>
  );
}
