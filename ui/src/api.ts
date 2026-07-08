import type { Actor, Issue, IssueDetail, Priority, Project, Status } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const getMe = () => api<Actor>("/api/me");
export const listActors = () => api<Actor[]>("/api/actors");
export const listProjects = () => api<Project[]>("/api/projects");
export const listIssues = (
  filters: { project?: string; status?: Status; needsInput?: boolean; excludeSnoozed?: boolean } = {},
) => {
  const q = new URLSearchParams();
  if (filters.project) q.set("project", filters.project);
  if (filters.status) q.set("status", filters.status);
  if (filters.needsInput) q.set("needs_input", "true");
  if (filters.excludeSnoozed) q.set("exclude_snoozed", "true");
  const qs = q.toString();
  return api<Issue[]>(`/api/issues${qs ? `?${qs}` : ""}`);
};
export const getIssue = (ref: string) => api<IssueDetail>(`/api/issues/${ref}`);
export const updateIssue = (
  ref: string,
  patch: Partial<{ status: Status; priority: Priority; title: string; description: string; assigneeName: string | null; labels: string[] }>,
) => api<Issue>(`/api/issues/${ref}`, { method: "PATCH", body: JSON.stringify(patch) });
export const createIssue = (input: { projectKey: string; title: string; description?: string; priority?: Priority }) =>
  api<Issue>("/api/issues", { method: "POST", body: JSON.stringify(input) });
export const claimIssue = (ref: string) => api<Issue>(`/api/issues/${ref}/claim`, { method: "POST" });
export const addComment = (ref: string, body: string) =>
  api<{ ok: true }>(`/api/issues/${ref}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const requestInput = (ref: string, question: string) =>
  api<Issue>(`/api/issues/${ref}/request-input`, { method: "POST", body: JSON.stringify({ question }) });
export const snoozeIssue = (ref: string, until: number) =>
  api<Issue>(`/api/issues/${ref}/snooze`, { method: "POST", body: JSON.stringify({ until }) });
export const markDuplicate = (ref: string, of: string) =>
  api<Issue>(`/api/issues/${ref}/duplicate`, { method: "POST", body: JSON.stringify({ of }) });
export const logout = () => api<{ ok: true }>("/auth/logout", { method: "POST" });
