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
//
// Only the REAL wire spellings of the two hardware (security-key) types are
// accepted — `ssh -Q key` output, exactly as it appears in a .pub file:
// sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com. This is
// deliberately narrower than "any SSH key": per the 2026-07-16 affirmation
// relay design §3, the server can never verify that user-verification (PIN /
// fingerprint) occurred at signing time — ssh-keygen -Y verify has no such
// flag. The ONLY server-side hardware guarantee left is this key-type check
// at enrollment, so it must reject plain software keys (ssh-ed25519, ssh-rsa,
// ecdsa-sha2-nistp256) which can sign with no presence check at all.
const KEY_LINE = /^(sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( .*)?$/;

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
      "That is not a hardware security-key public key. Affirmation keys must be a " +
        "FIDO/U2F security key (sk-ssh-ed25519@openssh.com or " +
        "sk-ecdsa-sha2-nistp256@openssh.com) — generate one with e.g. " +
        '`ssh-keygen -t ed25519-sk -f ~/.ssh/affirm_key`. A plain software key ' +
        "(ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256) can sign with no PIN, fingerprint, " +
        "or touch, so it cannot stand in for a human — enroll a security key instead.",
    );
  }
  try {
    return db
      .insert(affirmationKeys)
      .values({ actorId: target.id, publicKey: line, comment: comment ?? null })
      .returning()
      .get();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new SwitchyardError(
        `"${target.name}" already has this key enrolled and live — revoke it first if you mean to replace it.`,
      );
    }
    throw err;
  }
}

// better-sqlite3 throws a SqliteError (not a SwitchyardError) on a UNIQUE
// constraint violation — e.g. re-enrolling a key that's already live under
// affirmation_keys_active_uniq. Left uncaught, that's a raw stack trace
// through the CLI for what is really a routine "you already did this"
// operator mistake. We match by `code` (stable across better-sqlite3
// versions) rather than parsing the message.
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
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
 * Per `man ssh-keygen` ALLOWED SIGNERS (verified against OpenSSH_10.2p1, not
 * just read — see the 2026-07-16 affirmation relay design §3), the format
 * supports exactly four comma-separated options: `cert-authority`,
 * `namespaces=`, `valid-after=`, `valid-before=`. There is NO `verify-required`
 * option there — that spelling exists only as an `-O` flag at certificate
 * signing and at key generation, and a real `ssh-keygen -Y verify` run against
 * a line carrying it fails outright ("invalid key"). So this function takes no
 * `verifyRequired` parameter; that parameter existed only to serve an option
 * that does not exist, and its removal is not a scope cut — production would
 * have failed on every verification, permanently.
 *
 * The server-side guarantee this gate actually provides is: a valid signature
 * from a key enrolled to this human, in the `switchyard-affirm` namespace, from
 * a key whose type was checked as hardware (`sk-*@openssh.com`) at enrollment
 * time (see `enrollAffirmationKey`'s `KEY_LINE`). It is NOT "the server
 * verified a PIN or fingerprint" — `ssh-keygen -Y verify` cannot check that bit
 * at all; presence/UV is enforced by the FIDO token at signing time. Any
 * user-facing copy about this should say "PIN or fingerprint, depending on
 * your key" (per the man page's "PIN or on-token biometrics") and must never
 * claim the server verified it.
 */
export function buildAllowedSigners(keys: AffirmationKeyRow[], principal: string): string {
  if (/[\s,]/.test(principal)) {
    throw new SwitchyardError(
      `Actor name "${principal}" contains whitespace or a comma and cannot be used as an ` +
        "allowed_signers principal — that field is space-separated and would corrupt the line.",
    );
  }
  return keys.map((k) => `${principal} namespaces="${AFFIRM_NAMESPACE}" ${k.publicKey}`).join("\n") + "\n";
}
