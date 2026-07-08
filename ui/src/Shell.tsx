import type { ReactNode } from "react";
import type { Actor, Project } from "./types";
import { href, useRoute } from "./router";
import { logout, listIssues } from "./api";
import { usePoll } from "./usePoll";

export default function Shell(props: { me: Actor; projects: Project[]; children: ReactNode }) {
  const route = useRoute();
  const currentProject =
    route.view === "board" ? route.project : props.projects[0]?.key ?? "";
  const inReview = usePoll(() => listIssues({ status: "in_review" }), [], 30000);

  return (
    <>
      <header className="topbar">
        <span className="logo">⧉ Switchyard</span>
        <nav>
          <a href="#/" className={route.view === "triage" ? "active" : ""}>Triage</a>
          <a
            href={currentProject ? href({ view: "board", project: currentProject }) : "#/"}
            className={route.view === "board" ? "active" : ""}
          >
            Board
          </a>
          <a href="#/review" className={route.view === "review" ? "active" : ""}>
            Review{inReview.data && inReview.data.length > 0 && <span className="badge">{inReview.data.length}</span>}
          </a>
        </nav>
        {route.view === "board" && (
          <select
            value={route.project}
            onChange={(e) => { location.hash = href({ view: "board", project: e.target.value }); }}
          >
            {props.projects.map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
          </select>
        )}
        <span className="spacer" />
        <span className="badge actor">{props.me.name}</span>
        <button onClick={() => logout().then(() => location.reload())}>Log out</button>
      </header>
      <div className="content">{props.children}</div>
    </>
  );
}
