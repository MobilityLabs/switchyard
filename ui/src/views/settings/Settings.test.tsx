// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Settings from "./Settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(tab: Parameters<typeof Settings>[0]["tab"]): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Settings tab={tab} />);
  });
  return container;
}

describe("Settings shell (SYD-158)", () => {
  it("renders a tab per admin area with the active tab marked", async () => {
    const container = await render("integrations");
    const tabs = [...container.querySelectorAll(".tabs a")];
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Projects",
      "Bot identities",
      "Integrations",
      "Config",
    ]);
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/settings",
      "/settings/actors",
      "/settings/integrations",
      "/settings/config",
    ]);
    expect(container.querySelector(".tabs a.active")?.textContent).toBe("Integrations");
  });
});
