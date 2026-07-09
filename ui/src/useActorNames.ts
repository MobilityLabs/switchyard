import { listActors } from "./api";
import { usePoll } from "./usePoll";

// Actor names change rarely; a minute-long poll is plenty fresh for the
// @mention highlighter (SYD-57) without hammering the endpoint on every
// comment render.
export function useActorNames(): string[] {
  const { data } = usePoll(listActors, [], 60000);
  return data?.map((a) => a.name) ?? [];
}
