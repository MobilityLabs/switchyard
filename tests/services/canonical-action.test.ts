import { describe, expect, it } from "vitest";
import {
  canonicalizeAction,
  AFFIRM_NAMESPACE,
  type CanonicalAction,
} from "../../src/services/canonical-action.js";

const base: CanonicalAction = {
  v: 1,
  pendingActionId: 17,
  sessionId: 4,
  issueRef: "SYD-42",
  actionType: "done",
  expectedHeadSha: "abc123",
  expiresAt: 1784180000,
};

describe("canonicalizeAction", () => {
  it("is independent of key insertion order", () => {
    const reordered = {
      expiresAt: base.expiresAt,
      actionType: base.actionType,
      v: base.v,
      issueRef: base.issueRef,
      expectedHeadSha: base.expectedHeadSha,
      sessionId: base.sessionId,
      pendingActionId: base.pendingActionId,
    } as CanonicalAction;
    expect(canonicalizeAction(reordered)).toBe(canonicalizeAction(base));
  });

  it("omits an absent expectedHeadSha rather than emitting null", () => {
    const { expectedHeadSha: _drop, ...without } = base;
    const out = canonicalizeAction(without as CanonicalAction);
    expect(out).not.toContain("expectedHeadSha");
    expect(out).not.toContain("null");
  });

  it("treats an explicitly-undefined field identically to an absent one", () => {
    const { expectedHeadSha: _drop, ...without } = base;
    expect(canonicalizeAction({ ...without, expectedHeadSha: undefined } as CanonicalAction)).toBe(
      canonicalizeAction(without as CanonicalAction),
    );
  });

  it("distinguishes two different issues — the replay property", () => {
    expect(canonicalizeAction({ ...base, issueRef: "SYD-43" })).not.toBe(canonicalizeAction(base));
  });

  it("is stable across unicode", () => {
    const u = { ...base, issueRef: "SYD-é" };
    expect(canonicalizeAction(u)).toBe(canonicalizeAction({ ...u }));
  });

  it("pins the namespace", () => {
    expect(AFFIRM_NAMESPACE).toBe("switchyard-affirm");
  });

  it("does not carry an extra property from a spread onto a wider-shaped source into the output", () => {
    const withExtra = { ...base, secretColumn: "leak-me", id: 999 } as CanonicalAction & {
      secretColumn: string;
      id: number;
    };
    const out = canonicalizeAction(withExtra);
    expect(out).not.toContain("secretColumn");
    expect(out).not.toContain("leak-me");
    expect(out).not.toMatch(/"id"/);
    expect(out).toBe(canonicalizeAction(base));
  });

  it("throws rather than emitting null for a non-finite numeric field", () => {
    expect(() => canonicalizeAction({ ...base, sessionId: NaN })).toThrow();
    expect(() => canonicalizeAction({ ...base, pendingActionId: Infinity })).toThrow();
    expect(() => canonicalizeAction({ ...base, expiresAt: -Infinity })).toThrow();
  });

  it("canonicalizes NFC and NFD forms of the same logical string identically", () => {
    const nfc = { ...base, issueRef: "SYD-é" }; // precomposed é
    const nfd = { ...base, issueRef: "SYD-é" }; // decomposed e + combining acute
    expect(canonicalizeAction(nfc)).toBe(canonicalizeAction(nfd));
  });
});
