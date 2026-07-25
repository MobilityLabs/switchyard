// @vitest-environment jsdom
//
// Adversarial suite for the markdown pipeline (SYD-34), porting the cases
// from the 2026-07-08 markdown security review. Covers the DOMPurify
// sanitizer config, the link-target hook, the input-type pin, and the
// autolinker's escaping and code-token exclusions.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./Markdown";

const REPO = "https://github.com/MobilityLabs/switchyard";

function toDom(
  markdown: string,
  projectKey = "SYD",
  knownActorNames: readonly string[] = [],
): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(markdown, projectKey, knownActorNames);
  return el;
}

describe("sanitizer", () => {
  it("strips <script> tags", () => {
    const el = toDom('hello <script>alert("xss")</script> world');
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).not.toContain("alert");
  });

  it("strips explicitly forbidden event handlers (onerror)", () => {
    // Uses an allowed attachment src so the element survives as an <img> (an
    // external src would be replaced with a plain link — see the img-src
    // allowlist tests below) and we can assert onerror is stripped from it.
    const el = toDom('<img src="/api/attachments/1/x.png" onerror="alert(1)">');
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
    const input = toDom('<input type="text" value="paste your token here">').querySelector(
      "input",
    )!;
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

  it("strips external img src, replacing it with a plain link (tracking-pixel defense)", () => {
    const el = toDom("![tracker](https://evil.example/pixel.png)");
    expect(el.querySelector("img")).toBeNull();
    const a = el.querySelector("a")!;
    expect(a).not.toBeNull();
    expect(a.getAttribute("href")).toBe("https://evil.example/pixel.png");
    expect(a.textContent).toBe("tracker");
  });

  it("strips protocol-relative img src too (same-origin-looking bypass)", () => {
    const el = toDom('<img src="//evil.example/pixel.png" alt="x">');
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a")).not.toBeNull();
  });

  it("allows img src pointing at the attachment-serving route", () => {
    const el = toDom("![shot.png](/api/attachments/12/shot.png)");
    const img = el.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/api/attachments/12/shot.png");
    expect(el.querySelector("a")).toBeNull();
  });

  it("renders a <video> below a link to an attachment mp4/webm/mov", () => {
    const el = toDom("[clip.mp4](/api/attachments/7/clip.mp4)");
    const video = el.querySelector("video")!;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe("/api/attachments/7/clip.mp4");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
  });

  it("does not add a video element for a non-attachment link, even with a video extension", () => {
    const el = toDom("[clip.mp4](https://evil.example/clip.mp4)");
    expect(el.querySelector("video")).toBeNull();
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

  it("links a #N reference to the repo's pull URL", () => {
    const a = toDom("fixed in #20").querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`${REPO}/pull/20`);
    expect(a.textContent).toBe("#20");
  });

  it("links the #N even when written as 'PR #20'", () => {
    const a = toDom("Fixed in consolidation PR #20 (commit b3084f4)").querySelector(
      "a[href$='/pull/20']",
    )!;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe("#20");
  });

  it("leaves a bare # with no digits as literal text", () => {
    const el = toDom("a C# tag and a # alone");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("C# tag");
    expect(el.textContent).toContain("# alone");
  });

  it("does not autolink #N inside inline code", () => {
    const el = toDom("`#20`");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("code")!.textContent).toBe("#20");
  });

  it("does not autolink #N inside fenced code blocks", () => {
    const el = toDom("```\nsee #20\n```");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("pre code")).not.toBeNull();
  });

  it("leaves #N as plain text for unknown project keys", () => {
    const el = toDom("see #20", "NOPE");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("#20");
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

describe("syntax highlighting (SYD-58)", () => {
  it("wraps a hinted fenced block in hljs-* spans", () => {
    const el = toDom("```ts\nconst x: number = 1;\n```");
    const code = el.querySelector("pre code")!;
    expect(code.getAttribute("class")).toBe("language-ts");
    expect(code.querySelectorAll("span[class^='hljs-']").length).toBeGreaterThan(0);
    expect(code.textContent).toContain("const x: number = 1;");
  });

  it("recognizes aliased language hints (sh, html, tsx)", () => {
    const sh = toDom("```sh\necho hi\n```").querySelector("pre code")!;
    expect(sh.querySelectorAll("span[class^='hljs-']").length).toBeGreaterThan(0);
    const html = toDom("```html\n<div></div>\n```").querySelector("pre code")!;
    expect(html.querySelectorAll("span[class^='hljs-']").length).toBeGreaterThan(0);
    const tsx = toDom("```tsx\nconst x = <div/>;\n```").querySelector("pre code")!;
    expect(tsx.querySelectorAll("span[class^='hljs-']").length).toBeGreaterThan(0);
  });

  it("renders an unknown-language fence as plain text, no crash", () => {
    const el = toDom("```python\nprint('hi')\n```");
    const code = el.querySelector("pre code")!;
    expect(code.querySelector("span")).toBeNull();
    expect(code.textContent).toContain("print('hi')");
  });

  it("renders an unhinted fence as plain text", () => {
    const el = toDom("```\nplain text\n```");
    const code = el.querySelector("pre code")!;
    expect(code.querySelector("span")).toBeNull();
    expect(code.hasAttribute("class")).toBe(false);
    expect(code.textContent).toContain("plain text");
  });

  it("does not highlight inline code spans", () => {
    const el = toDom("use `const x = 1` inline");
    const code = el.querySelector("code")!;
    expect(code.parentElement?.tagName.toLowerCase()).not.toBe("pre");
    expect(code.querySelector("span")).toBeNull();
  });

  it("keeps a script/onerror payload inside a fence inert", () => {
    const el = toDom('```html\n<script>alert(1)</script><img src=x onerror="alert(2)">\n```');
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("alert(1)");
    // Must render as syntax-highlighted text, not live markup.
    const code = el.querySelector("pre code")!;
    expect(code.querySelector("script, img")).toBeNull();
  });
});

describe("mentions (SYD-57)", () => {
  it("highlights a leading @agent summons with the stronger style", () => {
    const el = toDom("@agent can you take a look?");
    const span = el.querySelector("span.mention")!;
    expect(span).not.toBeNull();
    expect(span.textContent).toBe("@agent");
    expect(span.classList.contains("mention-lead")).toBe(true);
  });

  it("highlights a mid-text mention without the leading style", () => {
    const el = toDom("thanks @agent, cc @sean", "SYD", ["sean"]);
    const spans = [...el.querySelectorAll("span.mention")];
    expect(spans.map((s) => s.textContent)).toEqual(["@agent", "@sean"]);
    expect(spans.every((s) => !s.classList.contains("mention-lead"))).toBe(true);
  });

  it("preserves actor name casing and matches names containing slashes", () => {
    const el = toDom("assigning to @claude/dev", "SYD", ["claude/dev"]);
    const span = el.querySelector("span.mention")!;
    expect(span).not.toBeNull();
    expect(span.textContent).toBe("@claude/dev");
  });

  it("leaves an unknown mention as plain text", () => {
    const el = toDom("hey @nobody are you there");
    expect(el.querySelector("span.mention")).toBeNull();
    expect(el.textContent).toContain("@nobody");
  });

  it("does not highlight @agent inside an inline code span", () => {
    const el = toDom("use `@agent` in the composer");
    expect(el.querySelector("span.mention")).toBeNull();
    expect(el.querySelector("code")!.textContent).toBe("@agent");
  });

  it("does not highlight @agent inside a fenced code block", () => {
    const el = toDom("```\n@agent\n```");
    expect(el.querySelector("span.mention")).toBeNull();
    expect(el.querySelector("pre code")!.textContent).toBe("@agent\n");
  });

  it("only gives the lead style to the very first @agent, not later repeats", () => {
    const el = toDom("@agent look, then later @agent again");
    const spans = [...el.querySelectorAll("span.mention")];
    expect(spans.map((s) => s.textContent)).toEqual(["@agent", "@agent"]);
    expect(spans[0].classList.contains("mention-lead")).toBe(true);
    expect(spans[1].classList.contains("mention-lead")).toBe(false);
  });

  it("does not give the lead style when @agent appears mid-text only", () => {
    const el = toDom("hey @agent, got a sec?");
    const span = el.querySelector("span.mention")!;
    expect(span).not.toBeNull();
    expect(span.classList.contains("mention-lead")).toBe(false);
  });
});
