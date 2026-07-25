import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AFFIRM_NAMESPACE } from "./canonical-action.js";

/**
 * Verifies an SSHSIG blob over `message` using OpenSSH itself.
 *
 * There is no custom crypto here — that is why we shell out to ssh-keygen
 * rather than owning a WebAuthn relying-party implementation.
 *
 * WHAT THIS PROVES: the signature is valid, was made by a key enrolled to this
 * principal, and covers the `switchyard-affirm` namespace.
 *
 * WHAT IT DOES NOT PROVE: that the human touched the key or entered a PIN.
 * `ssh-keygen -Y verify` has NO user-verification flag, and `verify-required`
 * is NOT an ALLOWED SIGNERS option (only cert-authority, namespaces=,
 * valid-after=, valid-before= are). An earlier draft of this design claimed
 * otherwise, citing a man-page block that actually documents a CERTIFICATE
 * critical-option; real ssh-keygen rejected the resulting line with
 * `allowed_signers:1: invalid key`. See spec §3. Presence is enforced by the
 * FIDO token at signing time; the only server-side hardware guarantee is
 * enrollAffirmationKey's sk-* key-type check. Do not restate the old claim.
 *
 * Returns false for any verification failure. THROWS if ssh-keygen is missing:
 * a verifier that fails open is worse than no verifier (the npm lesson, §7), so
 * a misconfigured deployment must be a loud 500 and never a soft allow.
 */
export function verifySshSig(args: {
  message: string;
  armoredSignature: string;
  allowedSigners: string;
  principal: string;
}): boolean {
  const dir = mkdtempSync(join(tmpdir(), "syd-affirm-"));
  try {
    const signersPath = join(dir, "allowed_signers");
    const sigPath = join(dir, "sig");
    writeFileSync(signersPath, args.allowedSigners, { mode: 0o600 });
    writeFileSync(sigPath, args.armoredSignature, { mode: 0o600 });
    try {
      execFileSync(
        "ssh-keygen",
        [
          "-Y",
          "verify",
          "-f",
          signersPath,
          "-I",
          args.principal,
          "-n",
          AFFIRM_NAMESPACE,
          "-s",
          sigPath,
        ],
        { input: args.message, stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "ssh-keygen is not installed on the server — signed affirmations cannot be verified. Install openssh-client.",
        );
      }
      return false; // non-zero exit == verification failed
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
