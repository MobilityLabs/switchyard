import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Actor, Project } from "./types";
import { getLastProject, href, isIssueRef, navigate, useRoute, type Route } from "./router";
import { logout, listIssues, createProject, ApiError } from "./api";
import { usePoll } from "./usePoll";

const KEY_PATTERN = /^[A-Z]{2,10}$/;

function NewProjectForm(props: { projects: Project[]; onCreated: (p: Project) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const keyValid = KEY_PATTERN.test(key);
  const keyTaken = props.projects.some((p) => p.key === key);
  const canSubmit = keyValid && !keyTaken && trimmedName.length > 0 && !submitting;

  function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    createProject({ key, name: trimmedName }).then(
      (project) => props.onCreated(project),
      (e) => { setSubmitting(false); setError(e instanceof ApiError ? e.message : String(e)); },
    );
  }

  return (
    <div className="new-project-popover panel">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === "Escape") props.onCancel(); }}>
        <label>
          Key
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="ACME"
            maxLength={10}
            autoFocus
          />
        </label>
        {key.length > 0 && !keyValid && <p className="hint">2–10 uppercase letters, e.g. "ACME".</p>}
        {keyValid && keyTaken && <p className="hint">A project with key "{key}" already exists.</p>}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
        </label>
        <p className="banner warn">
          The key is permanent — issue refs like {key || "KEY"}-1 can never be changed later.
        </p>
        {error && <p className="error-bar">{error}</p>}
        <div className="popover-actions">
          <button className="primary" type="submit" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create project"}
          </button>
          <button type="button" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

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
      onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      placeholder="Search… (SYD-52, or a word) — press /"
    />
  );
}

export default function Shell(props: { me: Actor; projects: Project[]; children: ReactNode }) {
  const route = useRoute();
  const [showNewProject, setShowNewProject] = useState(false);
  const [justCreated, setJustCreated] = useState<Project | null>(null);
  const lastProject = getLastProject();

  // Optimistic: the poll that feeds props.projects only refreshes every 15s,
  // so splice a just-created project into the list immediately and drop the
  // splice once the real list catches up (avoids ever showing a duplicate).
  useEffect(() => {
    if (justCreated && props.projects.some((p) => p.key === justCreated.key)) setJustCreated(null);
  }, [props.projects, justCreated]);
  const allProjects = justCreated ? [...props.projects, justCreated] : props.projects;

  const rememberedProject = allProjects.some((p) => p.key === lastProject) ? lastProject : null;
  const currentProject =
    route.view === "board" ? route.project : rememberedProject ?? allProjects[0]?.key ?? "";

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

  function onProjectCreated(project: Project) {
    setJustCreated(project);
    setShowNewProject(false);
    navigate({ view: "board", project: project.key });
  }

  // Triage/Review tabs default to the last project you were looking at
  // (SYD-55) rather than always landing on "All projects" — but a bare
  // /triage or /review URL (an old bookmark, a fresh link) still means
  // "All projects", so this only shapes the nav link target, not routing.
  const triageHref = route.view === "triage" ? href(route) : href({ view: "triage", project: rememberedProject });
  const reviewHref =
    route.view === "review" ? href(route) : href({ view: "review", project: rememberedProject, ref: null });

  return (
    <>
      <header className="topbar">
        <span className="logo">⧉ Switchyard</span>
        <nav>
          <a href={triageHref} className={route.view === "triage" ? "active" : ""}>Triage</a>
          <a
            href={currentProject ? href({ view: "board", project: currentProject }) : href({ view: "triage", project: null })}
            className={route.view === "board" ? "active" : ""}
          >
            Board
          </a>
          <a href={reviewHref} className={route.view === "review" ? "active" : ""}>
            Review{inReview.data && inReview.data.length > 0 && <span className="badge">{inReview.data.length}</span>}
          </a>
        </nav>
        <SearchBox route={route} />
        {(route.view === "board" || route.view === "triage" || route.view === "review") && (
          <select
            value={route.view === "board" ? route.project : route.project ?? ""}
            onChange={(e) => {
              if (route.view === "board") navigate({ view: "board", project: e.target.value });
              else if (route.view === "triage") navigate({ view: "triage", project: e.target.value || null });
              else navigate({ view: "review", project: e.target.value || null, ref: null });
            }}
          >
            {route.view !== "board" && <option value="">All projects</option>}
            {allProjects.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
          </select>
        )}
        <span className="project-switcher-actions">
          <button onClick={() => setShowNewProject((v) => !v)}>+ Project</button>
          {showNewProject && (
            <NewProjectForm
              projects={allProjects}
              onCreated={onProjectCreated}
              onCancel={() => setShowNewProject(false)}
            />
          )}
        </span>
        <span className="spacer" />
        <button className="primary" onClick={() => navigate({ view: "new-issue" })}>+ New issue</button>
        <span className="badge actor">{props.me.name}</span>
        <button onClick={() => logout().then(() => location.reload())}>Log out</button>
      </header>
      <div className="content">{props.children}</div>
    </>
  );
}
