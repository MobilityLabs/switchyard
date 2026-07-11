import { useRef } from "react";
import { listActors } from "./api";
import { usePoll } from "./usePoll";

const EMPTY: string[] = [];

// Actor names change rarely; a minute-long poll is plenty fresh for the
// @mention highlighter (SYD-57) without hammering the endpoint on every
// comment render.
//
// Returns a reference that's stable across renders as long as the actual
// names haven't changed. `data` is a fresh array from every poll tick (and
// callers like IssueDetail re-render on unrelated 15s polls too), so without
// this a naive `.map()` would hand every consumer a new array each time —
// including Markdown's useMemo deps (SYD-130), forcing a full re-sanitize of
// every rendered comment/description on ticks where nothing changed.
export function useActorNames(): string[] {
  const { data } = usePoll(listActors, [], 60000);
  const prev = useRef(EMPTY);
  const names = data?.map((a) => a.name) ?? EMPTY;
  if (names.length !== prev.current.length || names.some((n, i) => n !== prev.current[i])) {
    prev.current = names;
  }
  return prev.current;
}
