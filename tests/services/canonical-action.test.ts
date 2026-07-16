import { describe, expect, it } from "vitest";
import { canonicalizeAction, AFFIRM_NAMESPACE, type CanonicalAction } from "../../src/services/canonical-action.js";

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
});
