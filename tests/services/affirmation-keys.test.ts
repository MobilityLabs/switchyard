import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor, type ActorType } from "../../src/services/actors.js";
import {
  buildAllowedSigners,
  enrollAffirmationKey,
  listAffirmationKeys,
  revokeAffirmationKey,
} from "../../src/services/affirmation-keys.js";

// No shared freshDb/makeActor helper module exists in this repo (every
// tests/services/*.test.ts inlines its own setup) — these mirror that
// convention rather than importing from a module that isn't there.
const freshDb = (): Db => openDb(":memory:");
const makeActor = (db: Db, name: string, type: ActorType): Actor =>
  createActor(db, { name, type }).actor;

const KEY = "ssh-ed25519-sk AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA keyring";

describe("buildAllowedSigners", () => {
  it("emits verify-required and the namespace in production shape", () => {
    const out = buildAllowedSigners(
      [{ publicKey: KEY } as never],
      "sean",
      { verifyRequired: true },
    );
    expect(out).toContain('namespaces="switchyard-affirm"');
    expect(out).toContain("verify-required");
    expect(out.startsWith("sean ")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("omits verify-required when not required (test-path only)", () => {
    expect(buildAllowedSigners([{ publicKey: KEY } as never], "sean", { verifyRequired: false }))
      .not.toContain("verify-required");
  });

  it("emits one line per key — the recovery story is redundancy", () => {
    const out = buildAllowedSigners(
      [{ publicKey: KEY } as never, { publicKey: `${KEY}2` } as never],
      "sean",
      { verifyRequired: true },
    );
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("affirmation key enrollment", () => {
  it("enrolls, lists live keys, and drops revoked ones", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const row = enrollAffirmationKey(db, human, human, KEY, "keyring");
    expect(listAffirmationKeys(db, human.id)).toHaveLength(1);
    revokeAffirmationKey(db, human, row.id);
    expect(listAffirmationKeys(db, human.id)).toHaveLength(0);
  });

  it("is human-only — an agent cannot enroll a key for anyone", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const agent = makeActor(db, "claude/dev", "agent");
    expect(() => enrollAffirmationKey(db, agent, human, KEY)).toThrow(/human/i);
  });

  it("refuses a key for a non-human actor — only humans affirm", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const agent = makeActor(db, "claude/dev", "agent");
    expect(() => enrollAffirmationKey(db, human, agent, KEY)).toThrow(/human/i);
  });

  it("rejects a malformed public key", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    expect(() => enrollAffirmationKey(db, human, human, "not-a-key")).toThrow(/public key/i);
  });
});
