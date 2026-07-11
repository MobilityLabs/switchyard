// @vitest-environment jsdom
//
// Adversarial suite for the design-embed classifier and iframe construction
// (SYD-34), porting the URL-parsing cases from the 2026-07-08 markdown
// security review.
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DesignEmbeds, classify, extractEmbeds } from "./DesignEmbeds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("classify", () => {
  it("accepts figma file/design/proto/board URLs", () => {
    expect(classify("https://figma.com/file/abc123/My-File")).toBe("figma");
    expect(classify("https://www.figma.com/design/xyz/Thing")).toBe("figma");
    expect(classify("https://figma.com/proto/abc")).toBe("figma");
    expect(classify("https://figma.com/board/abc")).toBe("figma");
  });

  it("rejects figma.com paths outside the allowlist", () => {
    expect(classify("https://figma.com/community/plugin/123")).toBeNull();
    expect(classify("https://figma.com/")).toBeNull();
  });

  it("rejects hostname-suffix spoofs", () => {
    expect(classify("https://figma.com.evil.example/file/abc")).toBeNull();
    expect(classify("https://evilfigma.com/file/abc")).toBeNull();
    expect(classify("https://evilpaper.design/x")).toBeNull();
  });

  it("rejects allowlisted hosts appearing only in the path", () => {
    expect(classify("https://evil.example/figma.com/file/abc")).toBeNull();
  });

  it("rejects userinfo spoofs (allowlisted host before @)", () => {
    expect(classify("https://figma.com@evil.example/file/abc")).toBeNull();
    expect(classify("https://paper.design@evil.example/")).toBeNull();
  });

  it("rejects subdomains other than www", () => {
    expect(classify("https://app.figma.com/file/abc")).toBeNull();
    expect(classify("https://sub.paper.design/x")).toBeNull();
  });

  it("rejects non-http(s) and unparseable URLs", () => {
    expect(classify("javascript:alert(1)")).toBeNull();
    expect(classify("not a url")).toBeNull();
  });

  it("accepts paper.design URLs", () => {
    expect(classify("https://paper.design/some/doc")).toBe("paper");
    expect(classify("https://www.paper.design/some/doc")).toBe("paper");
  });
});

describe("extractEmbeds", () => {
  it("dedupes, strips trailing punctuation, and ignores non-design URLs", () => {
    const text =
      "See https://figma.com/file/abc. Also https://figma.com/file/abc and https://example.com/x.";
    const embeds = extractEmbeds(text);
    expect(embeds).toEqual([{ url: "https://figma.com/file/abc", kind: "figma" }]);
  });
});

describe("DesignEmbeds iframe", () => {
  async function renderExpanded(text: string): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DesignEmbeds text={text} />);
    });
    const button = container.querySelector("button")!;
    expect(button).not.toBeNull();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return container;
  }

  it("sandboxes the preview iframe", async () => {
    const container = await renderExpanded("https://figma.com/file/abc");
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
  });

  it("routes figma URLs through the figma embed endpoint, encoded", async () => {
    const url = "https://figma.com/file/abc?node-id=1&t=2";
    const container = await renderExpanded(`look at ${url}`);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe(
      `https://www.figma.com/embed?embed_host=switchyard&url=${encodeURIComponent(url)}`,
    );
  });
});
