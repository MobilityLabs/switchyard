import { and, eq, isNull } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { affirmationKeys } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { AFFIRM_NAMESPACE } from "./canonical-action.js";
import { SwitchyardError } from "./errors.js";

export type AffirmationKeyRow = typeof affirmationKeys.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

// An authorized-keys-style line: "<type> <base64>[ comment]". We do not parse
// the key material — ssh-keygen is the only thing that gets to judge that. This
// catches paste errors early with a clear message, nothing more.
const KEY_LINE = /^(ssh-ed25519(-sk)?|ecdsa-sha2-nistp256(-sk)?|ssh-rsa) [A-Za-z0-9+/]+={0,3}( .*)?$/;

/**
 * Enrolls a public key that may sign `actor`'s affirmations.
 *
 * Human-only on BOTH sides: only a human may enroll, and only for a human.
 * An agent enrolling its own key would hand it the ceremony the gate exists to
 * demand — the one thing the design says an agent structurally cannot do.
 */
export function enrollAffirmationKey(
  db: Db,
  human: Actor,
  target: Actor,
  publicKey: string,
  comment?: string,
): AffirmationKeyRow {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can enroll an affirmation key.");
  }
  if (target.type !== "human") {
    throw new SwitchyardError(
      `Affirmation keys belong to humans — "${target.name}" is a ${target.type}, and only a human affirms.`,
    );
  }
  const line = publicKey.trim();
  if (!KEY_LINE.test(line)) {
    throw new SwitchyardError(
      'That is not an SSH public key line — paste the contents of a .pub file, e.g. "ssh-ed25519-sk AAAA... comment".',
    );
  }
  return db
    .insert(affirmationKeys)
    .values({ actorId: target.id, publicKey: line, comment: comment ?? null })
    .returning()
    .get();
}

export function listAffirmationKeys(db: DbOrTx, actorId: number): AffirmationKeyRow[] {
  return db
    .select()
    .from(affirmationKeys)
    .where(and(eq(affirmationKeys.actorId, actorId), isNull(affirmationKeys.revokedAt)))
    .all();
}

export function revokeAffirmationKey(db: Db, human: Actor, id: number): void {
  if (human.type !== "human") {
    throw new SwitchyardError("Only a human can revoke an affirmation key.");
  }
  const changed = db
    .update(affirmationKeys)
    .set({ revokedAt: nowSec() })
    .where(and(eq(affirmationKeys.id, id), isNull(affirmationKeys.revokedAt)))
    .run();
  if (changed.changes === 0) {
    throw new SwitchyardError(`There is no live affirmation key ${id}.`);
  }
}

/**
 * Renders an OpenSSH allowed_signers file.
 *
 * `verify-required` is the prize: it makes `ssh-keygen -Y verify` reject any
 * signature whose user-verification bit is unset. We do not implement that
 * check — OpenSSH does. Per `man ssh-keygen` ALLOWED SIGNERS, UV is satisfied
 * "by PIN or on-token biometrics" depending on hardware — a YubiKey Bio uses a
 * fingerprint, a standard YubiKey uses a PIN. Both are the same guarantee for
 * this threat model (possession + a verified holder), so this comment (and any
 * user-facing text) says "PIN or fingerprint, depending on your key" — never
 * promises "fingerprint" or "biometric" as though guaranteed.
 *
 * `verifyRequired` is a parameter rather than a hardcoded true so the verify
 * plumbing can be tested with a software key (CI has no FIDO hardware) without
 * a test-only branch in production code. Production always passes true, and a
 * test asserts that shape.
 */
export function buildAllowedSigners(
  keys: AffirmationKeyRow[],
  principal: string,
  opts: { verifyRequired: boolean },
): string {
  const flags = opts.verifyRequired ? " verify-required" : "";
  return keys.map((k) => `${principal} namespaces="${AFFIRM_NAMESPACE}"${flags} ${k.publicKey}`).join("\n") + "\n";
}
