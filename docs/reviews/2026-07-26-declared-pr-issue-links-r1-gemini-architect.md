The split-read architecture—trusting `proposed` links for safe, reversible claim-blocking while demanding `confirmed` links for dangerous, irreversible delivery logic—is an exceptional piece of domain modeling. It perfectly balances the system's need to protect against double-work with the security requirement of explicit human authorization.

However, there is a critical lifecycle gap regarding the cardinality constraints of the `pr_state` table that will lead to permanently orphaned or deadlocked PRs.

### The Missing "Reject/Detach" Lifecycle (Proposal Lockout)

The plan makes the following structural assertions:
1. `(repo, prNumber)` is the primary key, so a PR links to at most one issue.
2. An agent calling `link_pr`, or a free-text scrape of a PR body, unilaterally creates a `proposed` link.
3. A proposal never overwrites an existing link. 

Because the primary key is consumed the moment a `proposed` link is created, the design assumes the first guess is always correct, just unconfirmed. 

If an agent hallucinates a `link_pr` call, or the free-text scraper guesses the wrong issue (e.g., someone types a typo'd issue ID in the PR body), PR #220 becomes bound to the *wrong* issue as `proposed`. 
* The true owner of PR #220 cannot link it to the correct issue because the primary key `(repo, 220)` is already taken. 
* The owner of the wrong issue sees a proposal banner, but the design only specifies a confirmation path ("A one-click confirm banner..."), completely omitting a **reject or detach** mechanism.

**Fix:**
The design must define the negative path for proposals. 
*   There must be an explicit UI/API action to reject an incorrect proposal.
*   The data model must define what happens upon rejection. If the system simply deletes the `pr_state` row, the free-text scraper might immediately re-propose it on the next webhook sync. If the system sets `issue_ref = null`, how does it record *which* issue it was rejected from to avoid a re-proposal loop, while still freeing up the PK for the correct issue to claim it?

The mechanics of proposal rejection and un-linking must be explicitly defined before implementation.

VERDICT: REVISE
