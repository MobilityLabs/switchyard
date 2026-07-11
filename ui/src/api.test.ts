// SYD-128: a 401 from any request — not just the boot-time getMe() — must
// flip the app back to the login screen instead of stranding the UI on an
// error bar. api() (and the multipart uploadAttachment() path, which bypasses
// it) both need to notify a registered handler before throwing.
import { describe, expect, it, vi, afterEach } from "vitest";
import { api, ApiError, listAgentSessions, listIssues, setUnauthorizedHandler, uploadAttachment } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("api() unauthorized handling", () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("calls the registered handler on a 401 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthorized" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not call the handler on a non-401 error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not call the handler on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: 1 })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(api("/api/me")).resolves.toEqual({ id: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops notifying once the handler is unregistered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthorized" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setUnauthorizedHandler(null);

    await expect(api("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("also notifies on a 401 from uploadAttachment's standalone fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "unauthorized" })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadAttachment("SYD-1", file)).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("api() error message mapping", () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("uses the response body's error field as the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: "bad title" })));
    await expect(api("/api/issues")).rejects.toMatchObject({ status: 400, message: "bad title" });
  });

  it("falls back to 'HTTP <status>' when the body has no error field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { oops: true })));
    await expect(api("/api/issues")).rejects.toMatchObject({ status: 500, message: "HTTP 500" });
  });

  it("falls back to 'HTTP <status>' when the body isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token"); } }) as unknown as Response),
    );
    await expect(api("/api/issues")).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  });

  it("resolves to {} on a successful response with an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError("Unexpected end of input"); } }) as unknown as Response),
    );
    await expect(api("/api/issues")).resolves.toEqual({});
  });

  it("resolves with the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: 1, ref: "SYD-1" })));
    await expect(api("/api/issues/SYD-1")).resolves.toEqual({ id: 1, ref: "SYD-1" });
  });
});

describe("query string building", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listIssues omits the query string entirely when no filters are given", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await listIssues();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/issues");
  });

  it("listIssues encodes every provided filter", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await listIssues({ project: "SYD", status: "todo", label: "bug", text: "foo bar", needsInput: true, excludeSnoozed: true });
    const url = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/api/issues");
    expect(url.searchParams.get("project")).toBe("SYD");
    expect(url.searchParams.get("status")).toBe("todo");
    expect(url.searchParams.get("label")).toBe("bug");
    expect(url.searchParams.get("text")).toBe("foo bar");
    expect(url.searchParams.get("needs_input")).toBe("true");
    expect(url.searchParams.get("exclude_snoozed")).toBe("true");
  });

  it("listAgentSessions encodes only the filters that are set", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await listAgentSessions({ ref: "SYD-1" });
    const url = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(url.searchParams.get("ref")).toBe("SYD-1");
    expect(url.searchParams.has("active")).toBe(false);
  });
});
