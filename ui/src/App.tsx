import { useEffect, useState } from "react";
import { getMe, ApiError, listProjects, logout } from "./api";
import type { Actor } from "./types";
import { useRoute } from "./router";
import { usePoll } from "./usePoll";
import Shell from "./Shell";
import Triage from "./views/Triage";

export default function App() {
  const [me, setMe] = useState<Actor | null>(null);
  const [authState, setAuthState] = useState<"loading" | "out" | "in">("loading");

  useEffect(() => {
    getMe()
      .then((a) => { setMe(a); setAuthState("in"); })
      .catch((e) => setAuthState(e instanceof ApiError && e.status === 401 ? "out" : "out"));
  }, []);

  if (authState === "loading") return <main className="center"><p>Loading…</p></main>;
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
      {route.view === "triage" && <Triage />}
      {route.view === "board" && <p>board: {route.project}</p>}
      {route.view === "issue" && <p>issue: {route.ref}</p>}
    </Shell>
  );
}
