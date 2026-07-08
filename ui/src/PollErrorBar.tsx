import { useEffect, useState } from "react";

/** Dismissible error bar for transient poll failures on an already-loaded view.
 * Resets its dismissed state whenever the error message changes (including
 * clearing when the poll recovers), so a fresh failure is never hidden by a
 * stale dismissal. */
export function PollErrorBar({ error }: { error: string | null }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [error]);

  if (!error || dismissed) return null;
  return (
    <p className="error-bar">{error} <button onClick={() => setDismissed(true)}>×</button></p>
  );
}
