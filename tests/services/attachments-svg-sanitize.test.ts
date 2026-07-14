import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "../../src/services/attachments.js";

function clean(svg: string): string {
  return sanitizeSvg(Buffer.from(svg, "utf8")).toString("utf8");
}

describe("sanitizeSvg", () => {
  it("strips <script> tags", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>`,
    );
    expect(out).not.toMatch(/script/i);
    expect(out).toContain("<circle");
  });

  it("strips event-handler attributes", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10" onclick="alert(2)"/></svg>`,
    );
    expect(out).not.toMatch(/onload|onclick/i);
    expect(out).toContain("<rect");
  });

  it("strips <foreignObject> and any content it carries", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject><circle r="1"/></svg>`,
    );
    expect(out).not.toMatch(/foreignObject/i);
    expect(out).not.toMatch(/script/i);
    expect(out).toContain("<circle");
  });

  it("strips javascript: URLs on href", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text x="0" y="10">click</text></a></svg>`,
    );
    expect(out).not.toMatch(/javascript:/i);
  });

  it("strips remote href/xlink:href references but keeps same-document fragment refs", () => {
    const remote = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/x.svg#icon"/></svg>`,
    );
    expect(remote).not.toMatch(/evil\.example/);

    const local = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><circle id="dot" r="2"/></defs><use href="#dot"/></svg>`,
    );
    expect(local).toContain('href="#dot"');
  });

  it("drops embedded <style> blocks wholesale rather than trying to parse CSS", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(javascript:alert(1))}</style><rect width="5" height="5"/></svg>`,
    );
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("<rect");
  });

  it("leaves a benign diagram intact", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>` +
      `<rect width="80" height="40" fill="url(#g)"/>` +
      `<text x="10" y="60">Service A</text>` +
      `<use href="#g"/>` +
      `</svg>`;
    const out = clean(svg);
    expect(out).toContain('viewBox="0 0 100 100"');
    expect(out).toContain("<linearGradient");
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain("Service A");
    expect(out).toContain('href="#g"');
  });
});
