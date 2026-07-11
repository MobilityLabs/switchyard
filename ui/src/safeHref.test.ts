import { describe, it, expect } from "vitest";
import { isSafeUrl, safeHref } from "./safeHref";

describe("isSafeUrl", () => {
  it("allows http and https", () => {
    expect(isSafeUrl("http://example.com/pr/1")).toBe(true);
    expect(isSafeUrl("https://github.com/org/repo/pull/1")).toBe(true);
  });

  it("allows mailto", () => {
    expect(isSafeUrl("mailto:someone@example.com")).toBe(true);
  });

  it("rejects javascript: urls", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects javascript: urls with control-character smuggling", () => {
    expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeUrl(" \n javascript:alert(1)")).toBe(false);
  });

  it("rejects data: urls", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects unparseable strings and relative paths", () => {
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("/api/attachments/1/file.png")).toBe(false);
  });
});

describe("safeHref", () => {
  it("passes through safe urls", () => {
    expect(safeHref("https://github.com/org/repo/pull/1")).toBe(
      "https://github.com/org/repo/pull/1",
    );
  });

  it("returns undefined for unsafe schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
  });

  it("returns undefined for null/undefined/empty input", () => {
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
  });
});
