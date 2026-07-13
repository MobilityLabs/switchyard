// Pure logic for the SYD-207 cutover backfill + preflight (spec:
// docs/2026-07-12-sync-simplification-assessment.md "Cutover backfill").
import { describe, it, expect } from "vitest";
import {
  preflightRepoBindings,
  selectBackfillWork,
  type GhPr,
} from "../../scripts/github-poll-lib.js";

function pr(number: number, branch: string, state: GhPr["state"] = "OPEN"): GhPr {
  return {
    number,
    headRefName: branch,
    headRefOid: `sha-${number}`,
    updatedAt: "2026-07-13T10:00:00Z",
    title: `PR ${number}`,
    body: null,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state,
    mergeCommit: state === "MERGED" ? { oid: `merge-${number}` } : null,
  };
}

describe("preflightRepoBindings (SYD-207)", () => {
  const serverProjects = [
    { id: 1, key: "SYD" },
    { id: 2, key: "AIPI" },
  ];

  it("passes when every configured project's repo is linked and bound to it", () => {
    expect(
      preflightRepoBindings(
        [{ projectKey: "SYD", repo: "acme/widgets" }],
        [{ fullName: "acme/widgets", projectId: 1 }],
        serverProjects,
      ),
    ).toEqual([]);
  });

  it("fails loud when the repo is not linked at all", () => {
    const problems = preflightRepoBindings(
      [{ projectKey: "SYD", repo: "acme/widgets" }],
      [],
      serverProjects,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("acme/widgets");
    expect(problems[0]).toContain("not linked");
  });

  it("fails loud when the repo is linked but not project-bound (projectId null)", () => {
    const problems = preflightRepoBindings(
      [{ projectKey: "SYD", repo: "acme/widgets" }],
      [{ fullName: "acme/widgets", projectId: null }],
      serverProjects,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not bound");
    expect(problems[0]).toContain("SYD");
  });

  it("fails loud when the repo is bound to a different project", () => {
    const problems = preflightRepoBindings(
      [{ projectKey: "SYD", repo: "acme/widgets" }],
      [{ fullName: "acme/widgets", projectId: 2 }],
      serverProjects,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("bound to a different project");
  });

  it("fails loud when the configured project key does not exist on the server", () => {
    const problems = preflightRepoBindings(
      [{ projectKey: "NOPE", repo: "acme/widgets" }],
      [{ fullName: "acme/widgets", projectId: 1 }],
      serverProjects,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NOPE");
  });

  it("reports one problem per broken project, none for healthy ones", () => {
    const problems = preflightRepoBindings(
      [
        { projectKey: "SYD", repo: "acme/widgets" },
        { projectKey: "AIPI", repo: "acme/api" },
      ],
      [{ fullName: "acme/widgets", projectId: 1 }],
      serverProjects,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("acme/api");
  });
});

describe("selectBackfillWork (SYD-207)", () => {
  it("keeps only strict agent/<ref> PRs from the window", () => {
    const window = [pr(1, "agent/SYD-9", "MERGED"), pr(2, "fix/syd-10-thing"), pr(3, "main")];
    const { agentPrs } = selectBackfillWork(window, 50, []);
    expect(agentPrs.map((p) => p.number)).toEqual([1]);
  });

  it("requests no per-branch lookups when the window was exhaustive", () => {
    // 2 results with limit 50: the repo's whole PR history fit in the window,
    // so a beyond-window PR cannot exist.
    const window = [pr(1, "agent/SYD-9", "MERGED"), pr(2, "agent/SYD-10")];
    const { lookupBranches } = selectBackfillWork(window, 50, ["SYD-9", "SYD-10", "SYD-11"]);
    expect(lookupBranches).toEqual([]);
  });

  it("requests per-branch lookups for uncovered refs when the window hit its limit", () => {
    // Window returned exactly `limit` PRs — older agent PRs may exist beyond
    // it (the SYD-179 shape), so every ref not covered in-window gets a
    // targeted lookup.
    const window = [pr(1, "agent/SYD-9", "MERGED"), pr(2, "fix/other")];
    const { lookupBranches } = selectBackfillWork(window, 2, ["SYD-9", "SYD-10"]);
    expect(lookupBranches).toEqual(["agent/SYD-10"]);
  });
});
