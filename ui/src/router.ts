import { useEffect, useState } from "react";

export type Route =
  | { view: "triage" }
  | { view: "board"; project: string }
  | { view: "issue"; ref: string }
  | { view: "review" };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "board" && parts[1]) return { view: "board", project: parts[1] };
  if (parts[0] === "issue" && parts[1]) return { view: "issue", ref: parts[1] };
  if (parts[0] === "review") return { view: "review" };
  return { view: "triage" };
}

export function href(route: Route): string {
  if (route.view === "board") return `#/board/${route.project}`;
  if (route.view === "issue") return `#/issue/${route.ref}`;
  if (route.view === "review") return `#/review`;
  return "#/";
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
