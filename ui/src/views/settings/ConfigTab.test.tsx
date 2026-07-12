// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SettingView } from "../../types";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listSettings: vi.fn(() => Promise.resolve([] as SettingView[])),
    putSetting: vi.fn(),
    resetSetting: vi.fn(),
  };
});

import { listSettings, putSetting, resetSetting } from "../../api";
import ConfigTab from "./ConfigTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: SettingView[] = [
  {
    key: "instance.name",
    value: "Switchyard",
    default: "Switchyard",
    isDefault: true,
    description: "Instance display name",
  },
  {
    key: "dispatch.max_concurrent",
    value: 3,
    default: 1,
    isDefault: false,
    description: "Max concurrent code-dispatch sessions",
  },
  {
    key: "webhooks.suppressed_events",
    value: ["progress_note"],
    default: ["progress_note"],
    isDefault: true,
    description: "Event types webhooks skip",
  },
];

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConfigTab />);
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fieldFor(container: HTMLElement, key: string): HTMLElement {
  const field = container.querySelector(`[data-setting="${key}"]`);
  if (!field) throw new Error(`no field for ${key}`);
  return field as HTMLElement;
}

function buttonIn(scope: Element, label: string): HTMLButtonElement {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

afterEach(() => {
  vi.mocked(listSettings).mockReset().mockResolvedValue([]);
  vi.mocked(putSetting).mockReset();
  vi.mocked(resetSetting).mockReset();
});

describe("ConfigTab (SYD-158)", () => {
  it("groups settings by key prefix with descriptions and default markers", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    const container = await render();

    const headings = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain("Instance");
    expect(headings).toContain("Dispatch");
    expect(headings).toContain("Webhooks");

    expect(container.textContent).toContain("Instance display name");
    expect(fieldFor(container, "instance.name").textContent).toContain("default");
    // Overridden setting shows a reset affordance instead of a default badge.
    const dispatchField = fieldFor(container, "dispatch.max_concurrent");
    expect(dispatchField.textContent).not.toContain("default");
    expect(buttonIn(dispatchField, "Reset").disabled).toBe(false);
  });

  it("saves a numeric setting as a number via PUT", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    vi.mocked(putSetting).mockResolvedValue({ ...SETTINGS[1], value: 5, isDefault: false });
    const container = await render();

    const field = fieldFor(container, "dispatch.max_concurrent");
    await type(field.querySelector("input")!, "5");
    await click(buttonIn(field, "Save"));
    expect(putSetting).toHaveBeenCalledWith("dispatch.max_concurrent", 5);
  });

  it("blocks a non-numeric value client-side", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    const container = await render();

    const field = fieldFor(container, "dispatch.max_concurrent");
    await type(field.querySelector("input")!, "lots");
    expect(buttonIn(field, "Save").disabled).toBe(true);
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("saves a string[] setting from a comma list", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    vi.mocked(putSetting).mockResolvedValue(SETTINGS[2]);
    const container = await render();

    const field = fieldFor(container, "webhooks.suppressed_events");
    await type(field.querySelector("input")!, "progress_note, comment");
    await click(buttonIn(field, "Save"));
    expect(putSetting).toHaveBeenCalledWith("webhooks.suppressed_events", [
      "progress_note",
      "comment",
    ]);
  });

  it("resets an overridden setting via DELETE", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    vi.mocked(resetSetting).mockResolvedValue({ ...SETTINGS[1], value: 1, isDefault: true });
    const container = await render();

    await click(buttonIn(fieldFor(container, "dispatch.max_concurrent"), "Reset"));
    expect(resetSetting).toHaveBeenCalledWith("dispatch.max_concurrent");
  });

  it("surfaces a server rejection inline", async () => {
    vi.mocked(listSettings).mockResolvedValue(SETTINGS);
    const { ApiError } = await import("../../api");
    vi.mocked(putSetting).mockRejectedValue(new ApiError(400, "Settings are human-only"));
    const container = await render();

    const field = fieldFor(container, "dispatch.max_concurrent");
    await type(field.querySelector("input")!, "5");
    await click(buttonIn(field, "Save"));
    expect(container.textContent).toContain("Settings are human-only");
  });
});
