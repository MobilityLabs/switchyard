import { useEffect, useState } from "react";
import { getMe, ApiError, listProjects } from "./api";
import type { Actor } from "./types";
import { isKnownPath, navigate, useRoute } from "./router";
import { usePoll } from "./usePoll";
import Shell from "./Shell";
import Triage from "./views/Triage";
import Board from "./views/Board";
import IssueDetail from "./views/IssueDetail";
import Review from "./views/Review";
import NewIssue from "./views/NewIssue";
import Search from "./views/Search";

// Intercepts clicks on same-origin anchors that point at a known client
// route and hands them to the History-API router instead of a full page
// load. Installed once at the app root, capture-phase, so it sees the click
// before any per-view onClick handler. Anchors it doesn't recognize (external
// links, target=_blank markdown/design-embed links, modified clicks) pass
// through untouched.
function useInternalLinkInterceptor() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      if (!isKnownPath(url.pathname)) return;
      e.preventDefault();
      navigate(url.pathname + url.search);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

export default function App() {
  const [me, setMe] = useState<Actor | null>(null);
  const [authState, setAuthState] = useState<"loading" | "out" | "in" | "error">("loading");

  useInternalLinkInterceptor();

  useEffect(() => {
    getMe()
      .then((a) => { setMe(a); setAuthState("in"); })
      .catch((e) => setAuthState(e instanceof ApiError && e.status === 401 ? "out" : "error"));
  }, []);

  if (authState === "loading") return <main className="center"><p>Loading…</p></main>;
  if (authState === "error") {
    return (
      <main className="center login">
        <h1>Switchyard</h1>
        <p className="error-bar">Can't reach the server. It may be restarting.</p>
        <button className="primary" onClick={() => location.reload()}>Retry</button>
      </main>
    );
  }
  if (authState === "out" || !me) {
    return (
      <main className="center login">
        <h1>Switchyard</h1>
        <p>You need a login link. On the server host, run:</p>
        <pre>npx tsx src/cli.ts /data/switchyard.db mint-login &lt;your-name&gt;</pre>
        <p>then open the printed URL in this browser (links are single-use, 15&nbsp;min).</p>
      </main>
    );
  }
  return (
    <ShellRouter me={me} />
  );
}

function ShellRouter({ me }: { me: Actor }) {
  const route = useRoute();
  const projects = usePoll(listProjects, []);
  return (
    <Shell me={me} projects={projects.data ?? []}>
      {route.view === "triage" && <Triage project={route.project} />}
      {route.view === "board" && <Board project={route.project} />}
      {route.view === "issue" && <IssueDetail refId={route.ref} />}
      {route.view === "review" && <Review project={route.project} currentRef={route.ref} />}
      {route.view === "new-issue" && <NewIssue />}
      {route.view === "search" && <Search query={route.query} />}
    </Shell>
  );
}
