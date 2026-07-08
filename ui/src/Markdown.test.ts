// @vitest-environment jsdom
//
// Adversarial suite for the markdown pipeline (SYD-34), porting the cases
// from the 2026-07-08 markdown security review. Covers the DOMPurify
// sanitizer config, the link-target hook, the input-type pin, and the
// autolinker's escaping and code-token exclusions.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./Markdown";

const REPO = "https://github.com/MobilityLabs/switchyard";

function toDom(markdown: string, projectKey = "SYD"): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(markdown, projectKey);
  return el;
}

describe("sanitizer", () => {
  it("strips <script> tags", () => {
    const el = toDom('hello <script>alert("xss")</script> world');
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).not.toContain("alert");
  });

  it("strips explicitly forbidden event handlers (onerror)", () => {
    const el = toDom('<img src="x" onerror="alert(1)">');
    const img = el.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.hasAttribute("onerror")).toBe(false);
  });

  it("strips event handlers beyond the FORBID_ATTR list", () => {
    const el = toDom(
      '<img src="x" onanimationstart="alert(1)"><a href="https://a.example" onfocus="alert(1)">x</a>',
    );
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.attributes) {
        expect(attr.name.startsWith("on")).toBe(false);
      }
    }
  });

  it("removes javascript: hrefs from markdown links", () => {
    const el = toDom("[click me](javascript:alert(1))");
    for (const a of el.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toContain("javascript");
    }
  });

  it("removes javascript: hrefs from raw HTML links, including entity-encoded", () => {
    const el = toDom(
      '<a href="javascript:alert(1)">a</a> <a href="javascript&colon;alert(1)">b</a>',
    );
    for (const a of el.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/javascript/i);
    }
  });

  it("removes data:text/html hrefs", () => {
    const el = toDom('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>');
    for (const a of el.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toContain("data:");
    }
  });

  it("strips iframes even though DesignEmbeds renders its own", () => {
    const el = toDom('<iframe src="https://evil.example"></iframe>');
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("strips style/svg/math (mXSS carriers)", () => {
    const el = toDom(
      "<style>*{background:url(x)}</style><svg><script>1</script></svg><math><mi>x</mi></math>",
    );
    expect(el.querySelector("style,svg,math,script")).toBeNull();
  });

  it("forces target=_blank rel=noreferrer on generated links", () => {
    const a = toDom("[x](https://example.com)").querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });

  it("overrides hostile target/rel on raw HTML links", () => {
    const a = toDom(
      '<a href="https://example.com" target="_self" rel="opener">x</a>',
    ).querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });

  it("keeps task-list checkboxes", () => {
    const input = toDom("- [x] done").querySelector("input")!;
    expect(input).not.toBeNull();
    expect(input.getAttribute("type")).toBe("checkbox");
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  it("pins raw <input type=text> to a disabled checkbox (UI-spoofing)", () => {
    const input = toDom('<input type="text" value="paste your token here">')
      .querySelector("input")!;
    expect(input).not.toBeNull();
    expect(input.getAttribute("type")).toBe("checkbox");
    expect(input.hasAttribute("value")).toBe(false);
    expect(input.hasAttribute("disabled")).toBe(true);
  });

  it("pins other input types (image/password) to disabled checkboxes", () => {
    const el = toDom(
      '<input type="image" src="https://evil.example/x.png"><input type="password">',
    );
    const inputs = el.querySelectorAll("input");
    expect(inputs.length).toBe(2);
    for (const input of inputs) {
      expect(input.getAttribute("type")).toBe("checkbox");
      expect(input.hasAttribute("disabled")).toBe(true);
    }
  });
});

describe("autolinker", () => {
  it("links repo-relative file paths", () => {
    const a = toDom("see src/db/client.ts for details").querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`${REPO}/blob/main/src/db/client.ts`);
    expect(a.querySelector("code")!.textContent).toBe("src/db/client.ts");
  });

  it("links path:line to a line anchor", () => {
    const a = toDom("crash at ui/src/Markdown.tsx:42").querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`${REPO}/blob/main/ui/src/Markdown.tsx#L42`);
    expect(a.querySelector("code")!.textContent).toBe("ui/src/Markdown.tsx:42");
  });

  it("links commit SHAs", () => {
    const a = toDom("fixed in b3084f4").querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`${REPO}/commit/b3084f4`);
  });

  it("falls back to plain <code> for unknown project keys", () => {
    const el = toDom("see src/db/client.ts and b3084f4", "NOPE");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelectorAll("code").length).toBe(2);
  });

  it("does not autolink inside inline code", () => {
    const el = toDom("`src/db/client.ts`");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("code")!.textContent).toBe("src/db/client.ts");
  });

  it("does not autolink inside fenced code blocks", () => {
    const el = toDom("```\nsrc/db/client.ts\nb3084f4\n```");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("pre code")).not.toBeNull();
  });

  it("escapes HTML metacharacters in autolinked text tokens", () => {
    // "<" and "&" in a text token must come out as text, not markup, even
    // though the autolinker splices its own HTML into the token.
    const el = toDom("1 < 2 & 3 near src/db/client.ts");
    expect(el.textContent).toContain("1 < 2 & 3");
    // Nothing but the paragraph, the link, and its code span may exist.
    const tags = [...el.querySelectorAll("*")].map((n) => n.tagName.toLowerCase());
    expect(tags.sort()).toEqual(["a", "code", "p"]);
  });
});
