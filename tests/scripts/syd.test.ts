// scripts/syd.ts — the pure parts. The I/O half is a single fetch, so the
// value here is that argv maps to the right call and that token precedence
// puts a HUMAN token ahead of a service one (a service actor cannot confirm a
// link at all — SYD-213).
import { describe, it, expect } from "vitest";
import { planCall, resolveToken, resolveUrl } from "../../scripts/syd.js";

describe("resolveToken", () => {
  it("prefers a human token over a service token", () => {
    expect(
      resolveToken({ SWITCHYARD_SERVICE_TOKEN: "svc", SWITCHYARD_HUMAN_TOKEN: "hum" }),
    ).toEqual({ token: "hum", key: "SWITCHYARD_HUMAN_TOKEN", humanPreferred: true });
  });

  it("prefers SWITCHYARD_HUMAN_TOKEN over SWITCHYARD_TOKEN", () => {
    expect(resolveToken({ SWITCHYARD_TOKEN: "a", SWITCHYARD_HUMAN_TOKEN: "b" })?.token).toBe("b");
  });

  it("falls back to a service token but flags it as not human", () => {
    expect(resolveToken({ SWITCHYARD_SERVICE_TOKEN: "svc" })).toEqual({
      token: "svc",
      key: "SWITCHYARD_SERVICE_TOKEN",
      humanPreferred: false,
    });
  });

  it("returns null when nothing is set", () => {
    expect(resolveToken({})).toBeNull();
  });
});

describe("resolveUrl", () => {
  it("prefers SWITCHYARD_URL and strips trailing slashes", () => {
    expect(resolveUrl({ SWITCHYARD_URL: "http://x:3300//" }, "http://cfg")).toBe("http://x:3300");
  });

  it("falls back to the worker config url", () => {
    expect(resolveUrl({}, "http://cfg:3300")).toBe("http://cfg:3300");
  });

  it("has a default when neither is set", () => {
    expect(resolveUrl({})).toMatch(/^http:\/\/.+:\d+$/);
  });
});

describe("planCall", () => {
  it("maps whoami", () => {
    expect(planCall(["whoami"])).toEqual({ method: "GET", path: "/me" });
  });

  it("maps pr-link declare", () => {
    expect(planCall(["pr-link", "declare", "SYD-280", "226"])).toMatchObject({
      method: "POST",
      path: "/issues/SYD-280/pr-links",
      body: { prNumber: 226 },
    });
  });

  it("maps pr-link confirm", () => {
    expect(planCall(["pr-link", "confirm", "SYD-280", "226"]).path).toBe(
      "/issues/SYD-280/pr-links/confirm",
    );
  });

  it("joins a multi-word revoke reason", () => {
    expect(
      planCall(["pr-link", "revoke", "SYD-280", "226", "linked", "the", "wrong", "PR"]),
    ).toMatchObject({ body: { reason: "linked the wrong PR" } });
  });

  it("refuses a revoke with no reason", () => {
    expect(() => planCall(["pr-link", "revoke", "SYD-280", "226"])).toThrow(/reason/i);
  });

  it("refuses a non-numeric PR", () => {
    expect(() => planCall(["pr-link", "declare", "SYD-280", "abc"])).toThrow(/not a PR number/i);
  });

  it("maps pr-link list to the issue read", () => {
    expect(planCall(["pr-link", "list", "SYD-280"])).toEqual({
      method: "GET",
      path: "/issues/SYD-280",
    });
  });

  it("passes arbitrary api calls through, normalizing a missing leading slash", () => {
    expect(planCall(["api", "post", "issues/SYD-1/comments", '{"body":"hi"}'])).toEqual({
      method: "POST",
      path: "/issues/SYD-1/comments",
      body: { body: "hi" },
    });
  });

  it("rejects unknown commands and subcommands", () => {
    expect(() => planCall(["nope"])).toThrow(/unknown command/i);
    expect(() => planCall(["pr-link", "nope", "SYD-1", "1"])).toThrow(/unknown pr-link/i);
  });
});
