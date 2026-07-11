import { describe, it, expect, vi } from "vitest";
import { fetchLinearExport, downloadUpload } from "../../scripts/import-linear-lib.js";

type GqlRequest = { query: string; variables?: Record<string, unknown> };

const ORG_PAYLOAD = {
  organization: { name: "Acme Inc.", urlKey: "acme" },
  teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] },
  workflowStates: {
    nodes: [{ id: "s1", name: "Todo", type: "unstarted", team: { key: "ENG" } }],
  },
  users: {
    nodes: [
      { id: "u1", name: "Sean Perkins", displayName: "sean", email: "s@a.com", active: true },
    ],
  },
};

function issueNode(id: string, number: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    identifier: `ENG-${number}`,
    number,
    team: { key: "ENG" },
    title: `Issue ${number}`,
    description: null,
    priority: 0,
    state: { name: "Todo", type: "unstarted" },
    assignee: null,
    creator: { id: "u1" },
    labels: { nodes: [{ name: "Bug" }] },
    parent: null,
    createdAt: "2025-05-01T10:00:00.000Z",
    updatedAt: "2025-05-01T10:00:00.000Z",
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    relations: { nodes: [] },
    attachments: { nodes: [] },
    ...extra,
  };
}

function gqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch mock that routes on query content and records every request. */
function mockFetch(handler: (req: GqlRequest) => unknown) {
  const requests: { req: GqlRequest; headers: Record<string, string> }[] = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as GqlRequest;
    requests.push({ req, headers: (init?.headers ?? {}) as Record<string, string> });
    return gqlResponse(handler(req));
  });
  return { impl: impl as unknown as typeof fetch, requests };
}

describe("fetchLinearExport", () => {
  it("follows issue pagination cursors and sends the API key in the Authorization header", async () => {
    const { impl, requests } = mockFetch((req) => {
      if (req.query.includes("organization")) return ORG_PAYLOAD;
      if (req.variables?.after === "c1") {
        return {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [issueNode("i2", 2)],
          },
        };
      }
      return {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [issueNode("i1", 1)],
        },
      };
    });

    const data = await fetchLinearExport({ apiKey: "lin_api_test", fetchImpl: impl });

    expect(data.orgName).toBe("Acme Inc.");
    expect(data.orgUrlKey).toBe("acme");
    expect(data.teams).toEqual([{ id: "t1", key: "ENG", name: "Engineering" }]);
    expect(data.states).toEqual([{ id: "s1", name: "Todo", type: "unstarted", teamKey: "ENG" }]);
    expect(data.issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(data.issues[0].description).toBe("");
    expect(data.issues[0].labels).toEqual(["Bug"]);
    expect(data.issues[0].creatorId).toBe("u1");
    expect(data.issues[0].assigneeId).toBeNull();

    const issuePages = requests.filter((r) => r.req.query.includes("issues("));
    expect(issuePages).toHaveLength(2);
    expect(issuePages[1].req.variables?.after).toBe("c1");
    expect(requests.every((r) => r.headers.Authorization === "lin_api_test")).toBe(true);
  });

  it("follows nested comment pagination per issue", async () => {
    const { impl, requests } = mockFetch((req) => {
      if (req.query.includes("organization")) return ORG_PAYLOAD;
      if (req.variables?.issueId === "i1") {
        return {
          issue: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "c2", body: "second", user: null, createdAt: "2025-05-01T12:00:00.000Z" }],
            },
          },
        };
      }
      return {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            issueNode("i1", 1, {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "cc1" },
                nodes: [
                  { id: "c1", body: "first", user: { id: "u1" }, createdAt: "2025-05-01T11:00:00.000Z" },
                ],
              },
            }),
          ],
        },
      };
    });

    const data = await fetchLinearExport({ apiKey: "k", fetchImpl: impl });
    expect(data.issues[0].comments).toEqual([
      { id: "c1", body: "first", authorId: "u1", createdAt: "2025-05-01T11:00:00.000Z" },
      { id: "c2", body: "second", authorId: null, createdAt: "2025-05-01T12:00:00.000Z" },
    ]);
    const followup = requests.find((r) => r.req.variables?.issueId === "i1");
    expect(followup?.req.variables?.after).toBe("cc1");
  });

  it("surfaces GraphQL errors as thrown errors", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(fetchLinearExport({ apiKey: "k", fetchImpl: impl })).rejects.toThrow(
      /rate limited/,
    );
  });

  it("surfaces HTTP failures as thrown errors", async () => {
    const impl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchLinearExport({ apiKey: "k", fetchImpl: impl })).rejects.toThrow(/401/);
  });
});

describe("downloadUpload", () => {
  it("sends the API key and returns the bytes", async () => {
    const impl = vi.fn(
      async () => new Response(Buffer.from("png-bytes"), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await downloadUpload("https://uploads.linear.app/a/b/c", "lin_api_test", impl);
    expect(result?.data.toString()).toBe("png-bytes");
    const init = (impl as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_test");
  });

  it("returns null on HTTP failure", async () => {
    const impl = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    expect(await downloadUpload("https://uploads.linear.app/a/b/c", "k", impl)).toBeNull();
  });
});
