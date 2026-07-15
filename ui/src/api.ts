import type {
  Actor,
  ActorWithStatus,
  AgentSession,
  Attachment,
  Issue,
  IssueDetail,
  PendingAction,
  PendingActionStatus,
  Priority,
  Project,
  Status,
  WebhookView,
  GithubRepoView,
  SettingView,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Set by the app root so any request — not just the boot-time getMe() — can
// flip global auth state to "logged out" the moment a session expires, e.g.
// leaving a tab open past the cookie TTL. Without this, subsequent polls and
// mutations just throw ApiError(401) and strand the UI on an error bar.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function toApiError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized?.();
  return new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json().catch(() => ({}))) as T;
}

export const getMe = () => api<Actor>("/api/me");
export const listActors = () => api<ActorWithStatus[]>("/api/actors");
export const createActor = (input: { name: string; type: "human" | "agent" }) =>
  api<{ actor: Actor; token: string }>("/api/actors", {
    method: "POST",
    body: JSON.stringify(input),
  });
export const rotateActorToken = (id: number) =>
  api<{ token: string }>(`/api/actors/${id}/rotate-token`, { method: "POST" });
export const revokeActorToken = (id: number) =>
  api<{ ok: true }>(`/api/actors/${id}/token`, { method: "DELETE" });
export const mintLoginLink = (id: number) =>
  api<{ url: string }>(`/api/actors/${id}/login-link`, { method: "POST" });
export const listProjects = () => api<Project[]>("/api/projects");
export const createProject = (input: { key: string; name: string }) =>
  api<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) });
export const updateProject = (key: string, input: { name: string }) =>
  api<Project>(`/api/projects/${key}`, { method: "PATCH", body: JSON.stringify(input) });
export const listIssues = (
  filters: {
    project?: string;
    status?: Status;
    label?: string;
    text?: string;
    needsInput?: boolean;
    excludeSnoozed?: boolean;
    attention?: "delivery_failed";
    openPr?: boolean;
  } = {},
) => {
  const q = new URLSearchParams();
  if (filters.project) q.set("project", filters.project);
  if (filters.status) q.set("status", filters.status);
  if (filters.label) q.set("label", filters.label);
  if (filters.text) q.set("text", filters.text);
  if (filters.needsInput) q.set("needs_input", "true");
  if (filters.excludeSnoozed) q.set("exclude_snoozed", "true");
  if (filters.attention) q.set("attention", filters.attention);
  if (filters.openPr !== undefined) q.set("open_pr", String(filters.openPr));
  const qs = q.toString();
  return api<Issue[]>(`/api/issues${qs ? `?${qs}` : ""}`);
};
export const getIssue = (ref: string) => api<IssueDetail>(`/api/issues/${ref}`);
export const listAttachments = (ref: string) => api<Attachment[]>(`/api/issues/${ref}/attachments`);
export const updateIssue = (
  ref: string,
  patch: Partial<{
    status: Status;
    priority: Priority;
    title: string;
    description: string;
    summary: string | null;
    assigneeName: string | null;
    labels: string[];
    workerPreference: string | null;
    parentRef: string | null;
    expectedHeadSha: string;
  }>,
) => api<Issue>(`/api/issues/${ref}`, { method: "PATCH", body: JSON.stringify(patch) });
export const createIssue = (input: {
  projectKey: string;
  title: string;
  description?: string;
  summary?: string;
  priority?: Priority;
  workerPreference?: string | null;
  parentRef?: string;
}) => api<Issue>("/api/issues", { method: "POST", body: JSON.stringify(input) });
export const claimIssue = (ref: string) =>
  api<Issue>(`/api/issues/${ref}/claim`, { method: "POST" });
export const addComment = (ref: string, body: string) =>
  api<{ ok: true }>(`/api/issues/${ref}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
export const requestInput = (ref: string, question: string) =>
  api<Issue>(`/api/issues/${ref}/request-input`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });
export const snoozeIssue = (ref: string, until: number) =>
  api<Issue>(`/api/issues/${ref}/snooze`, { method: "POST", body: JSON.stringify({ until }) });
export const markDuplicate = (ref: string, of: string) =>
  api<Issue>(`/api/issues/${ref}/duplicate`, { method: "POST", body: JSON.stringify({ of }) });
export const redeliverIssue = (ref: string, expectedHeadSha?: string) =>
  api<Issue>(`/api/issues/${ref}/redeliver`, {
    method: "POST",
    body: JSON.stringify({ expectedHeadSha }),
  });
export const resolveDeliveryFailure = (ref: string, note?: string) =>
  api<Issue>(`/api/issues/${ref}/resolve-delivery`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
export const addDependency = (blockerRef: string, blockedRef: string) =>
  api<{ ok: true }>("/api/dependencies", {
    method: "POST",
    body: JSON.stringify({ blockerRef, blockedRef }),
  });
export const removeDependency = (blockerRef: string, blockedRef: string) =>
  api<{ ok: true }>(
    `/api/dependencies?blockerRef=${encodeURIComponent(blockerRef)}&blockedRef=${encodeURIComponent(blockedRef)}`,
    { method: "DELETE" },
  );
export const logout = () => api<{ ok: true }>("/auth/logout", { method: "POST" });
export const listAgentSessions = (filters: { active?: boolean; ref?: string } = {}) => {
  const q = new URLSearchParams();
  if (filters.active) q.set("active", "true");
  if (filters.ref) q.set("ref", filters.ref);
  const qs = q.toString();
  return api<AgentSession[]>(`/api/agent-sessions${qs ? `?${qs}` : ""}`);
};

export async function uploadAttachment(
  ref: string,
  file: File,
): Promise<{ id: number; url: string; markdown: string }> {
  const form = new FormData();
  form.set("file", file);
  // Don't route this through api() — it forces a JSON content-type header,
  // which would stop the browser from setting the multipart boundary.
  const res = await fetch(`/api/issues/${ref}/attachments`, { method: "POST", body: form });
  if (!res.ok) throw await toApiError(res);
  return (await res.json().catch(() => ({}))) as { id: number; url: string; markdown: string };
}

export const listPendingActions = (status: PendingActionStatus = "pending") =>
  api<PendingAction[]>(`/api/pending-actions?status=${status}`);
// Cookie-only by design (src/rest/pending-actions.ts): resolves the human from
// the switchyard_session cookie a same-origin fetch sends automatically, not
// from a bearer — never add an Authorization header here.
export const affirmPendingAction = (id: number) =>
  api<Issue>(`/api/pending-actions/${id}/affirm`, { method: "POST" });

export const listWebhooks = () => api<WebhookView[]>("/api/webhooks");
export const addWebhook = (input: { url: string; projectKey?: string; secret?: string }) =>
  api<WebhookView>("/api/webhooks", { method: "POST", body: JSON.stringify(input) });
export const setWebhookActive = (id: number, active: boolean) =>
  api<WebhookView>(`/api/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
export const removeWebhook = (id: number) =>
  api<{ ok: true }>(`/api/webhooks/${id}`, { method: "DELETE" });
export const listGithubRepos = () => api<GithubRepoView[]>("/api/github-repos");
export const addGithubRepo = (input: { fullName: string; projectKey?: string; secret?: string }) =>
  api<GithubRepoView>("/api/github-repos", { method: "POST", body: JSON.stringify(input) });
export const removeGithubRepo = (id: number) =>
  api<{ ok: true }>(`/api/github-repos/${id}`, { method: "DELETE" });
export const listSettings = () => api<SettingView[]>("/api/settings");
export const putSetting = (key: string, value: unknown) =>
  api<SettingView>(`/api/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) });
export const resetSetting = (key: string) =>
  api<SettingView>(`/api/settings/${key}`, { method: "DELETE" });
