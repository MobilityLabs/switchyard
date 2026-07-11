// @vitest-environment jsdom
//
// SYD-128: getMe() at boot already maps a 401 to the login screen, but no
// *subsequent* request did — leaving a tab open past the session TTL used
// to strand every view on a raw "HTTP 401" error bar. App now registers a
// global unauthorized handler so any later 401 (a poll, a mutation) bounces
// back to login too.
import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { api } from "./api";
import type { Actor } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME: Actor = { id: 1, name: "sean", type: "human" };

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function renderApp(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  await act(async () => {}); // flush getMe() resolution
  return container;
}

describe("App session expiry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  it("shows the app after a successful boot getMe()", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([]))),
    );

    const container = await renderApp();
    expect(container.textContent).not.toContain("You need a login link");
  });

  it("bounces back to the login screen when a later request 401s", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([])));
    vi.stubGlobal("fetch", fetchMock);

    const container = await renderApp();
    expect(container.textContent).not.toContain("You need a login link");

    // Simulate a poll or mutation hitting an expired session sometime later.
    fetchMock.mockImplementationOnce(
      async () =>
        ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) as Response,
    );
    await act(async () => {
      await api("/api/issues").catch(() => {});
    });

    expect(container.textContent).toContain("You need a login link");
  });

  it("does not touch auth state on a non-401 error from a later request", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([])));
    vi.stubGlobal("fetch", fetchMock);

    const container = await renderApp();

    fetchMock.mockImplementationOnce(
      async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response,
    );
    await act(async () => {
      await api("/api/issues").catch(() => {});
    });

    expect(container.textContent).not.toContain("You need a login link");
  });

  it("unregisters its handler on unmount so a stray late 401 is a no-op", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([])));
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {});

    await act(async () => {
      root.unmount();
    });

    fetchMock.mockImplementationOnce(
      async () =>
        ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) as Response,
    );
    // Should not throw despite no mounted App to receive the state update.
    await expect(api("/api/issues")).rejects.toBeTruthy();
  });
});
