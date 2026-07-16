import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createActor, type Actor, type ActorType } from "../../src/services/actors.js";
import {
  buildAllowedSigners,
  enrollAffirmationKey,
  listAffirmationKeys,
  revokeAffirmationKey,
} from "../../src/services/affirmation-keys.js";
import { SwitchyardError } from "../../src/services/errors.js";

// No shared freshDb/makeActor helper module exists in this repo (every
// tests/services/*.test.ts inlines its own setup) — these mirror that
// convention rather than importing from a module that isn't there.
const freshDb = (): Db => openDb(":memory:");
const makeActor = (db: Db, name: string, type: ActorType): Actor =>
  createActor(db, { name, type }).actor;

// Real wire spellings only (`ssh -Q key`) — "ssh-ed25519-sk" is the
// `ssh-keygen -t` argument spelling and never appears in a .pub file.
const KEY = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA keyring";

describe("buildAllowedSigners", () => {
  it("emits the namespace, no options join, and the production shape", () => {
    const out = buildAllowedSigners([{ publicKey: KEY } as never], "sean");
    expect(out).toContain('namespaces="switchyard-affirm"');
    // The bug this fixes: `verify-required` is NOT a valid ALLOWED SIGNERS
    // option (real ssh-keygen rejects a line carrying it outright — see the
    // round-trip test below). It must never appear in emitted output.
    expect(out).not.toContain("verify-required");
    expect(out.startsWith("sean ")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("emits one line per key — the recovery story is redundancy", () => {
    const out = buildAllowedSigners(
      [{ publicKey: KEY } as never, { publicKey: `${KEY}2` } as never],
      "sean",
    );
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });

  it("rejects a principal containing whitespace", () => {
    expect(() => buildAllowedSigners([{ publicKey: KEY } as never], "sean smith")).toThrow(
      SwitchyardError,
    );
  });

  it("rejects a principal containing a comma", () => {
    expect(() => buildAllowedSigners([{ publicKey: KEY } as never], "sean,evil")).toThrow(
      SwitchyardError,
    );
  });

  // THE TEST THAT WOULD HAVE CAUGHT THE `verify-required` BUG.
  //
  // A substring assertion on generated config is not evidence that OpenSSH
  // accepts the file — the original `toContain("verify-required")` test
  // passed against a line real ssh-keygen rejects outright
  // ("allowed_signers:1: invalid key"). This test instead round-trips
  // buildAllowedSigners' actual output through the real `ssh-keygen` binary:
  // generate a software key, sign a message, verify it against the emitted
  // allowed_signers file, and assert exit 0. It also proves `namespaces=` is
  // actually enforced by the binary (not merely present in the string) by
  // showing a wrong-namespace signature fails.
  //
  // A software key is fine here — and is the point, not a compromise. Per
  // the 2026-07-16 design §3, allowed_signers carries no `verify-required`
  // (it isn't a real option), so a software key verifies through the exact
  // same production code path a hardware key would. CI has no FIDO hardware;
  // this test still exercises real crypto through the real binary, no mocks.
  it("round-trips real output through the actual ssh-keygen binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "affirm-keys-test-"));
    try {
      const keyPath = join(dir, "id");
      const pubPath = `${keyPath}.pub`;
      const msgPath = join(dir, "message.txt");
      const sigPath = `${msgPath}.sig`;
      const signersPath = join(dir, "allowed_signers");
      const message = '{"v":1,"pendingActionId":17,"issueRef":"SYD-42"}';

      const gen = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath]);
      expect(gen.status, gen.stderr?.toString()).toBe(0);

      const pub = readFileSync(pubPath, "utf8").trim();
      const row = { publicKey: pub } as never; // not enrolled — enrollment's sk-* check is tested separately

      const allowedSigners = buildAllowedSigners([row], "sean");
      writeFileSync(signersPath, allowedSigners);

      writeFileSync(msgPath, message);
      const sign = spawnSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", "switchyard-affirm", msgPath]);
      expect(sign.status, sign.stderr?.toString()).toBe(0);

      const verify = spawnSync(
        "ssh-keygen",
        ["-Y", "verify", "-f", signersPath, "-I", "sean", "-n", "switchyard-affirm", "-s", sigPath],
        { input: message },
      );
      expect(verify.status, verify.stdout?.toString() + verify.stderr?.toString()).toBe(0);
      expect(verify.stdout.toString()).toMatch(/Good "switchyard-affirm" signature/);

      // Prove namespaces= is actually enforced by the binary, not just
      // present in the emitted string.
      const wrongNamespace = spawnSync(
        "ssh-keygen",
        ["-Y", "verify", "-f", signersPath, "-I", "sean", "-n", "wrong-namespace", "-s", sigPath],
        { input: message },
      );
      expect(wrongNamespace.status).not.toBe(0);
      expect(wrongNamespace.stderr.toString()).toMatch(/namespace does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(() => enrollAffirmationKey(db, human, human, "not-a-key")).toThrow(/security key/i);
  });

  it("rejects a software key that cannot enforce presence, with an explanatory message", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const softwareKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZ0Y2YwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw laptop";
    expect(() => enrollAffirmationKey(db, human, human, softwareKey)).toThrow(SwitchyardError);
    expect(() => enrollAffirmationKey(db, human, human, softwareKey)).toThrow(/security key/i);
  });

  it("rejects the -sk `ssh-keygen -t` argument spelling — only the real wire spelling is valid", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const wrongSpelling = "ssh-ed25519-sk AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA keyring";
    expect(() => enrollAffirmationKey(db, human, human, wrongSpelling)).toThrow(SwitchyardError);
  });

  it("throws a clear SwitchyardError on duplicate live enrollment, not a raw SqliteError", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    enrollAffirmationKey(db, human, human, KEY, "keyring");
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring again")).toThrow(SwitchyardError);
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring again")).toThrow(
      /already has this key enrolled/i,
    );
  });

  it("allows re-enrolling the same key after it was revoked", () => {
    const db = freshDb();
    const human = makeActor(db, "sean", "human");
    const row = enrollAffirmationKey(db, human, human, KEY, "keyring");
    revokeAffirmationKey(db, human, row.id);
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring again")).not.toThrow();
    expect(listAffirmationKeys(db, human.id)).toHaveLength(1);
  });

  // FINDING 1: isUniqueConstraintError used to match any err.code starting
  // with "SQLITE_CONSTRAINT" — which also matches SQLITE_CONSTRAINT_FOREIGNKEY
  // (affirmationKeys.actorId is a NOT-NULL FK and src/db/index.ts runs with
  // foreign_keys=ON). A bug that inserted a bad actorId would then be
  // misreported as "you already have this key enrolled" instead of a real
  // 500. Prove the FK violation is NOT swallowed as a duplicate: it must
  // propagate as a raw error (not the "already enrolled" SwitchyardError),
  // and specifically must carry SQLITE_CONSTRAINT_FOREIGNKEY, confirming the
  // two extended codes are genuinely distinct in this driver.
  it("does not misreport a foreign-key violation as a duplicate enrollment", () => {
    const db = freshDb();
    const human = { id: 999999, name: "ghost", type: "human" } as Actor;
    let caught: unknown;
    try {
      enrollAffirmationKey(db, human, human, KEY, "keyring");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(SwitchyardError);
    expect((caught as { code?: string }).code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });
});

describe("enrollAffirmationKey principal validation", () => {
  // FINDING 2: actors.ts places no restriction on actor names, so a human
  // named e.g. "Sean Perkins" could enroll with no error today and only
  // discover the break when they try to affirm and buildAllowedSigners
  // throws deep in the affirm flow. Prove enrollment now fails early, at the
  // moment the bad name is chosen, with a clear SwitchyardError.
  it("rejects enrollment for an actor whose name contains whitespace", () => {
    const db = freshDb();
    const human = makeActor(db, "Sean Perkins", "human");
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring")).toThrow(SwitchyardError);
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring")).toThrow(/whitespace|comma/i);
  });

  it("rejects enrollment for an actor whose name contains a comma", () => {
    const db = freshDb();
    const human = makeActor(db, "sean,evil", "human");
    expect(() => enrollAffirmationKey(db, human, human, KEY, "keyring")).toThrow(SwitchyardError);
  });
});
