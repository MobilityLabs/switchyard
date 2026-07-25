import type { LinearComment, LinearExport, LinearIssue } from "../src/services/linear-import.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const ISSUE_PAGE_SIZE = 50;
const NESTED_PAGE_SIZE = 100;

export type FetchLinearOptions = {
  apiKey: string;
  /** Import only this team (Linear team key, e.g. "ENG"). */
  teamKey?: string;
  fetchImpl?: typeof fetch;
};

type GqlPageInfo = { hasNextPage: boolean; endCursor: string | null };
type GqlUserRef = { id: string } | null;
type GqlCommentNode = { id: string; body: string; user: GqlUserRef; createdAt: string };
type GqlIssueNode = {
  id: string;
  identifier: string;
  number: number;
  team: { key: string };
  title: string;
  description: string | null;
  priority: number;
  state: { name: string; type: string };
  assignee: GqlUserRef;
  creator: GqlUserRef;
  labels: { nodes: { name: string }[] };
  parent: { identifier: string } | null;
  createdAt: string;
  updatedAt: string;
  comments: { pageInfo: GqlPageInfo; nodes: GqlCommentNode[] };
  relations: { nodes: { type: string; relatedIssue: { identifier: string } | null }[] };
  attachments: { nodes: { id: string; title: string; url: string }[] };
};

async function gql<T>(
  opts: FetchLinearOptions,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opts.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("Linear API returned no data.");
  return body.data;
}

const ORG_QUERY = `query Org {
  organization { name urlKey }
  teams(first: 100) { nodes { id key name } }
  workflowStates(first: 250) { nodes { id name type team { key } } }
  users(first: 250, includeDisabled: true) { nodes { id name displayName email active } }
}`;

const COMMENT_FIELDS = `pageInfo { hasNextPage endCursor } nodes { id body user { id } createdAt }`;

const ISSUES_QUERY = `query Issues($after: String, $filter: IssueFilter) {
  issues(first: ${ISSUE_PAGE_SIZE}, after: $after, filter: $filter, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier number team { key } title description priority
      state { name type } assignee { id } creator { id }
      labels(first: ${NESTED_PAGE_SIZE}) { nodes { name } }
      parent { identifier }
      createdAt updatedAt
      comments(first: ${NESTED_PAGE_SIZE}) { ${COMMENT_FIELDS} }
      relations(first: ${NESTED_PAGE_SIZE}) { nodes { type relatedIssue { identifier } } }
      attachments(first: ${NESTED_PAGE_SIZE}) { nodes { id title url } }
    }
  }
}`;

const MORE_COMMENTS_QUERY = `query MoreComments($issueId: String!, $after: String) {
  issue(id: $issueId) { comments(first: ${NESTED_PAGE_SIZE}, after: $after) { ${COMMENT_FIELDS} } }
}`;

function toComment(node: GqlCommentNode): LinearComment {
  return {
    id: node.id,
    body: node.body,
    authorId: node.user?.id ?? null,
    createdAt: node.createdAt,
  };
}

async function fetchRemainingComments(
  opts: FetchLinearOptions,
  issueId: string,
  after: string | null,
): Promise<LinearComment[]> {
  const out: LinearComment[] = [];
  let cursor = after;
  for (;;) {
    const data = await gql<{
      issue: { comments: { pageInfo: GqlPageInfo; nodes: GqlCommentNode[] } };
    }>(opts, MORE_COMMENTS_QUERY, { issueId, after: cursor });
    const page = data.issue.comments;
    out.push(...page.nodes.map(toComment));
    if (!page.pageInfo.hasNextPage) return out;
    cursor = page.pageInfo.endCursor;
  }
}

/** Pulls everything the importer needs from a Linear workspace, read-only. */
export async function fetchLinearExport(opts: FetchLinearOptions): Promise<LinearExport> {
  const org = await gql<{
    organization: { name: string; urlKey: string };
    teams: { nodes: { id: string; key: string; name: string }[] };
    workflowStates: { nodes: { id: string; name: string; type: string; team: { key: string } }[] };
    users: {
      nodes: { id: string; name: string; displayName: string; email: string; active: boolean }[];
    };
  }>(opts, ORG_QUERY);

  const teams = org.teams.nodes.filter((t) => !opts.teamKey || t.key === opts.teamKey);
  if (opts.teamKey && teams.length === 0) {
    throw new Error(
      `No Linear team with key "${opts.teamKey}" — teams: ${org.teams.nodes.map((t) => t.key).join(", ")}.`,
    );
  }
  const teamKeys = new Set(teams.map((t) => t.key));

  const issues: LinearIssue[] = [];
  let cursor: string | null = null;
  for (;;) {
    const data: { issues: { pageInfo: GqlPageInfo; nodes: GqlIssueNode[] } } = await gql(
      opts,
      ISSUES_QUERY,
      {
        after: cursor,
        filter: opts.teamKey ? { team: { key: { eq: opts.teamKey } } } : null,
      },
    );
    for (const node of data.issues.nodes) {
      if (!teamKeys.has(node.team.key)) continue;
      const comments = node.comments.nodes.map(toComment);
      if (node.comments.pageInfo.hasNextPage) {
        comments.push(
          ...(await fetchRemainingComments(opts, node.id, node.comments.pageInfo.endCursor)),
        );
      }
      issues.push({
        id: node.id,
        identifier: node.identifier,
        number: node.number,
        teamKey: node.team.key,
        title: node.title,
        description: node.description ?? "",
        priority: node.priority,
        stateName: node.state.name,
        stateType: node.state.type,
        assigneeId: node.assignee?.id ?? null,
        creatorId: node.creator?.id ?? null,
        labels: node.labels.nodes.map((l) => l.name),
        parentIdentifier: node.parent?.identifier ?? null,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        comments,
        relations: node.relations.nodes
          .filter((r) => r.relatedIssue !== null)
          .map((r) => ({ type: r.type, relatedIdentifier: r.relatedIssue!.identifier })),
        attachments: node.attachments.nodes,
      });
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    cursor = data.issues.pageInfo.endCursor;
  }

  return {
    orgName: org.organization.name,
    orgUrlKey: org.organization.urlKey,
    teams,
    states: org.workflowStates.nodes
      .filter((s) => teamKeys.has(s.team.key))
      .map((s) => ({ id: s.id, name: s.name, type: s.type, teamKey: s.team.key })),
    users: org.users.nodes,
    issues,
  };
}

/** Downloads an uploads.linear.app file (auth-gated by the API key). Null = not retrievable. */
export async function downloadUpload(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Buffer } | null> {
  const res = await fetchImpl(url, { headers: { Authorization: apiKey } });
  if (!res.ok) return null;
  return { data: Buffer.from(await res.arrayBuffer()) };
}
