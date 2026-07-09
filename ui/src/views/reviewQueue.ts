// Pure helpers for review-queue selection, kept separate from Review.tsx so
// they're testable without mounting React. The "queue" is a snapshot of refs
// the reviewer is navigating through — it only advances when the reviewer
// moves (next/prev/approve/send back), not on every poll tick, so new
// arrivals never reorder or swap the item currently on screen.

export type QueueItem = { ref: string };

// Ref to land on when the current one isn't set (bare `/review`) or no
// longer resolvable — the first item of the queue, or null if it's empty.
export function firstRef(queue: readonly QueueItem[]): string | null {
  return queue[0]?.ref ?? null;
}

// Ref one step away from `currentRef` within `queue`, in `direction`.
// Returns null at either end (no wraparound) or when the queue/ref can't
// place a "next" — callers treat null as "nothing to move to".
export function pickAdjacentRef(
  queue: readonly QueueItem[],
  currentRef: string | null,
  direction: 1 | -1,
): string | null {
  if (queue.length === 0) return null;
  const index = currentRef ? queue.findIndex((item) => item.ref === currentRef) : -1;
  if (index === -1) return firstRef(queue);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= queue.length) return null;
  return queue[nextIndex].ref;
}

// How many items in the freshly-polled list aren't part of the reviewer's
// current queue yet — surfaced as a non-disruptive "N new" indicator.
export function countNewArrivals(list: readonly QueueItem[], queue: readonly QueueItem[]): number {
  const known = new Set(queue.map((item) => item.ref));
  return list.filter((item) => !known.has(item.ref)).length;
}
