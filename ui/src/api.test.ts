// SYD-128: a 401 from any request — not just the boot-time getMe() — must
// flip the app back to the login screen instead of stranding the UI on an
// error bar. api() (and the multipart uploadAttachment() path, which bypasses
// it) both need to notify a registered handler before throwing.
import { describe, expect, it, vi, afterEach } from "vitest";
import { api, ApiError, setUnauthorizedHandler, uploadAttachment } from "./api";

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
