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

describe("App boot states", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  it("shows a loading screen while the boot getMe() is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toContain("Loading");
  });

  it("shows the login screen when the boot getMe() 401s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) as Response,
      ),
    );
    const container = await renderApp();
    expect(container.textContent).toContain("You need a login link");
  });

  it("shows an unreachable-server screen when the boot getMe() fails with a non-401 error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response,
      ),
    );
    const container = await renderApp();
    expect(container.textContent).toContain("Can't reach the server");
    expect(container.textContent).not.toContain("You need a login link");
  });

  it("shows the unreachable-server screen when the boot fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const container = await renderApp();
    expect(container.textContent).toContain("Can't reach the server");
  });

  it("reloads the page when Retry is clicked on the unreachable-server screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response,
      ),
    );
    const container = await renderApp();
    const originalLocation = Object.getOwnPropertyDescriptor(window, "location")!;
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    try {
      const button = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Retry",
      );
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", originalLocation);
    }
  });
});

describe("App internal link interceptor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  function clickAnchor(
    container: HTMLElement,
    attrs: Record<string, string>,
    eventInit: MouseEventInit = {},
  ): MouseEvent {
    const anchor = document.createElement("a");
    for (const [k, v] of Object.entries(attrs)) anchor.setAttribute(k, v);
    anchor.textContent = "link";
    container.appendChild(anchor);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...eventInit,
    });
    anchor.dispatchEvent(event);
    return event;
  }

  it("intercepts a click on a known-path internal link, preventing the default navigation and routing client-side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([]))),
    );
    const container = await renderApp();

    const event = await act(async () => clickAnchor(container, { href: "/new" }));
    expect(event.defaultPrevented).toBe(true);
    expect(location.pathname).toBe("/new");
    expect(container.textContent).toContain("New issue");
  });

  it("does not intercept a click on an unknown path (falls through to a full navigation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([]))),
    );
    const container = await renderApp();

    const event = await act(async () => clickAnchor(container, { href: "/not-a-route" }));
    expect(event.defaultPrevented).toBe(false);
    expect(location.pathname).not.toBe("/not-a-route");
  });

  it("does not intercept a click on a target=_blank link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([]))),
    );
    const container = await renderApp();

    const event = await act(async () => clickAnchor(container, { href: "/new", target: "_blank" }));
    expect(event.defaultPrevented).toBe(false);
    expect(location.pathname).not.toBe("/new");
  });

  it("does not intercept a modified click (e.g. cmd/ctrl-click to open in a new tab)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/me" ? okJson(ME) : okJson([]))),
    );
    const container = await renderApp();

    const event = await act(async () =>
      clickAnchor(container, { href: "/new" }, { ctrlKey: true }),
    );
    expect(event.defaultPrevented).toBe(false);
    expect(location.pathname).not.toBe("/new");
  });
});
