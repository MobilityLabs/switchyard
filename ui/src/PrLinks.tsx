import { useMemo, useState } from "react";
import { confirmPrLink, declarePrLink, listGithubRepos, revokePrLink } from "./api";
import { usePoll } from "./usePoll";
import { PromptModal } from "./Modal";
import { safeHref } from "./safeHref";
import type { Activity, Actor, GithubRepoView, PrLinkView } from "./types";

// The one human-only act in the attribution model, given a home on the board
// (SYD-290). Before this, seeing/confirming/revoking a declared issue<->PR link
// needed a terminal, a checkout and a token — so the act the design most wants a
// person to make deliberately was the least reachable one, while every act it
// wants gated was a click away.
//
// The panel deliberately shows BOTH halves of the join per link:
//   declaration — who said this PR carries the work, and who vouched for it
//   observation — what GitHub was last seen doing to that PR
// because a confirmed link whose PR nothing ever observed is a valid statement
// that still proves nothing. Showing only the declaration would put a
// "confirmed ✓" beside a lit "done without a merged PR" banner and read as a
// bug in the banner rather than the missing half it actually is.

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function prUrl(link: PrLinkView): string {
  return link.observed?.url ?? `https://github.com/${link.repo}/pull/${link.prNumber}`;
}

/** PR numbers this issue's own timeline names, newest first, minus the ones already linked.
 *
 * Design §8's "did you mean?": the issues that need a link most are done ones
 * whose merge is already sitting in their activity feed, so the declare form
 * should offer that number rather than making a human go find it on GitHub. */
export function suggestedPrNumbers(activity: Activity[], links: PrLinkView[]): number[] {
  const linked = new Set(links.map((l) => l.prNumber));
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = activity.length - 1; i >= 0; i--) {
    const ev = activity[i];
    if (
      ev.type !== "gh_pr_merged" &&
      ev.type !== "gh_pr_opened" &&
      ev.type !== "gh_pr_reopened" &&
      ev.type !== "gh_pr_closed" &&
      ev.type !== "pr_opened" &&
      ev.type !== "delivered"
    ) {
      continue;
    }
    const n = Number(ev.payload.prNumber);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n) || linked.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** The repos a link on this issue may name — bound to its project, or unscoped. */
export function repoOptions(repos: GithubRepoView[], projectId: number): string[] {
  return repos
    .filter((r) => r.projectId === projectId || r.projectId === null)
    .map((r) => r.fullName);
}

type LinkStateLabel = { label: string; className: string; title: string };

/** How a link's two halves read as one status chip. */
export function linkState(link: PrLinkView): LinkStateLabel {
  if (link.observed === null) {
    return {
      label: "⚪ never observed",
      className: "badge pr-link-unobserved",
      title:
        "Nothing has ever observed this PR, so no declaration about it can prove the work landed. " +
        "PRs merged before ingestion was widened have no record at all.",
    };
  }
  if (link.observed.status === "merged") {
    return link.provesLanded
      ? {
          label: "✅ merged",
          className: "badge pr-link-merged",
          title: "Merged, and this link proves it landed.",
        }
      : {
          label: "🔒 merged, unproven",
          className: "badge warn",
          title:
            link.role === "references"
              ? "This PR merged, but a `references` suggestion never proves what carried the work."
              : link.confirmedBy === null
                ? "This PR merged, but nobody has confirmed the link yet."
                : "This PR merged before the link was declared, and no human confirmed it — so recency binding still applies.",
        };
  }
  return link.observed.status === "open"
    ? { label: "🔀 open", className: "badge pr-link-open", title: "GitHub last saw this PR open." }
    : {
        label: "🚫 closed",
        className: "badge pr-link-closed",
        title: "GitHub last saw this PR closed unmerged.",
      };
}

function Provenance({ link }: { link: PrLinkView }) {
  return (
    <span className="pr-link-provenance">
      declared by <strong>{link.declaredByName}</strong> · {when(link.declaredAt)}
      {link.confirmedByName === null ? (
        <>
          {" · "}
          <em className="pr-link-unconfirmed">unconfirmed</em>
        </>
      ) : (
        <>
          {" · confirmed by "}
          <strong>{link.confirmedByName}</strong>
          {link.confirmedAt !== null && ` · ${when(link.confirmedAt)}`}
          {!link.confirmedByHuman && " (not a human — recency still binds)"}
        </>
      )}
    </span>
  );
}

export default function PrLinks({
  refId,
  projectId,
  links,
  activity,
  me,
  onChanged,
  compact = false,
}: {
  refId: string;
  projectId: number;
  links: PrLinkView[];
  activity: Activity[];
  me: Actor;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PrLinkView | null>(null);
  const [prInput, setPrInput] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const repos = usePoll(listGithubRepos, [], 60000);

  const isHuman = me.type === "human";
  const options = useMemo(() => repoOptions(repos.data ?? [], projectId), [repos.data, projectId]);
  const suggestions = useMemo(() => suggestedPrNumbers(activity, links), [activity, links]);
  // One bound repo is the overwhelmingly common case, so don't make a human
  // pick from a list of one before they can declare anything.
  const targetRepo = repo ?? options[0] ?? null;

  const delivers = links.filter((l) => l.role === "delivers");
  const references = links.filter((l) => l.role === "references");

  const act = (fn: () => Promise<unknown>) =>
    fn().then(
      () => {
        setError(null);
        onChanged();
      },
      (e) => setError(e.message),
    );

  const declare = (prNumber: number, role?: "delivers") => {
    if (!targetRepo) {
      setError(
        "No GitHub repo is bound to this project — bind one in Settings → Integrations before declaring a link.",
      );
      return;
    }
    act(() =>
      declarePrLink(refId, { repo: targetRepo, prNumber, role }).then(() => setPrInput("")),
    );
  };

  const row = (link: PrLinkView) => {
    const state = linkState(link);
    return (
      <li key={link.id} className="pr-link-row">
        <a href={safeHref(prUrl(link))} target="_blank" rel="noreferrer" className="pr-link-number">
          #{link.prNumber}
        </a>{" "}
        <span className={state.className} title={state.title}>
          {state.label}
        </span>{" "}
        <Provenance link={link} />
        <span className="pr-link-actions">
          {/* Human-only, and hidden rather than left to 400: an agent viewing
              the board should not be shown an act it can never perform. A
              `references` link is excluded because confirming one is refused
              server-side — promoting it is the correct verb, offered below. */}
          {isHuman && link.role === "delivers" && link.confirmedBy === null && (
            <button
              className="primary pr-link-confirm"
              title="Vouch for this link — a human confirmation is what makes it proof-bearing"
              onClick={() =>
                act(() => confirmPrLink(refId, { repo: link.repo, prNumber: link.prNumber }))
              }
            >
              Confirm
            </button>
          )}
          {isHuman && link.role === "references" && (
            <button
              className="pr-link-promote"
              title="Promote this suggestion to a delivers link — supersedes it and confirms in one step"
              onClick={() => declare(link.prNumber, "delivers")}
            >
              This one carries the work
            </button>
          )}
          <button className="pr-link-revoke" onClick={() => setRevoking(link)}>
            Revoke…
          </button>
        </span>
        {link.observed === null && link.role === "delivers" && (
          <p className="pr-link-note">
            Nothing has observed <code>{link.repo}</code>#{link.prNumber}, so this link can&apos;t
            prove the work landed however it&apos;s confirmed. If it did land, clear the flag with
            &ldquo;Mark resolved…&rdquo; instead.
          </p>
        )}
      </li>
    );
  };

  return (
    <div className={`pr-links panel${compact ? " compact" : ""}`}>
      <h3>PR links</h3>
      {error && (
        <p className="error-bar">
          {error} <button onClick={() => setError(null)}>×</button>
        </p>
      )}

      {delivers.length > 0 ? (
        <ul className="pr-link-list">{delivers.map(row)}</ul>
      ) : (
        <p className="empty">
          No PR is declared as carrying this work. Nothing infers it from a branch name or a mention
          — someone has to say so.
        </p>
      )}

      {references.length > 0 && (
        <>
          <h4 className="pr-link-suggestions-head">
            Possibly related{" "}
            <span
              className="pr-link-hint"
              title="Free-text matches from PR titles and bodies. They gate nothing and prove nothing."
            >
              — suggestions from PR text
            </span>
          </h4>
          <ul className="pr-link-list pr-link-references">{references.map(row)}</ul>
        </>
      )}

      {isHuman && (
        <div className="pr-link-declare">
          <span>Declare a PR</span>
          {options.length > 1 && (
            <select value={targetRepo ?? ""} onChange={(e) => setRepo(e.target.value)}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          <input
            className="label-input pr-link-input"
            value={prInput}
            placeholder="PR #"
            inputMode="numeric"
            onChange={(e) => setPrInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (prInput) declare(Number(prInput));
            }}
          />
          <button disabled={!prInput} onClick={() => declare(Number(prInput))}>
            Declare
          </button>
          {suggestions.length > 0 && (
            <span className="pr-link-suggests">
              from this issue&apos;s timeline:{" "}
              {suggestions.slice(0, 3).map((n) => (
                <button key={n} className="link-button" onClick={() => declare(n)}>
                  #{n}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {revoking && (
        <PromptModal
          title={`Revoke ${refId}'s link to ${revoking.repo}#${revoking.prNumber} — why is it wrong?`}
          placeholder="e.g. that PR carries SYD-41, not this"
          onCancel={() => setRevoking(null)}
          onSubmit={(reason) => {
            const target = revoking;
            setRevoking(null);
            act(() =>
              revokePrLink(refId, {
                repo: target.repo,
                prNumber: target.prNumber,
                reason,
              }),
            );
          }}
        />
      )}
    </div>
  );
}
