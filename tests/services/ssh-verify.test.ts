import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAllowedSigners } from "../../src/services/affirmation-keys.js";
import { AFFIRM_NAMESPACE } from "../../src/services/canonical-action.js";
import { verifySshSig } from "../../src/services/ssh-verify.js";

// CI has no FIDO hardware, so these tests sign with a SOFTWARE ed25519 key.
// That costs us nothing: allowed_signers carries no verify-required (there is no
// such option — spec §3), so a software key verifies through the EXACT production
// path. These tests therefore exercise real ssh-keygen crypto with no mock and no
// production seam, and they are the only place that proves buildAllowedSigners'
// output is actually parseable by the binary.
// What they cannot cover: that the token demanded a touch/PIN. The server never
// sees that (spec §3) — the manual hardware run is the only evidence.
const dir = mkdtempSync(join(tmpdir(), "syd-sshverify-"));
const keyPath = join(dir, "k");
execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "test"]);
const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
const signers = buildAllowedSigners([{ publicKey: pub } as never], "sean");

const sign = (msg: string, namespace = AFFIRM_NAMESPACE) =>
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, "-"], {
    input: msg,
    encoding: "utf8",
  });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("verifySshSig", () => {
  const message = '{"actionType":"done","issueRef":"SYD-42","v":1}';

  it("accepts a signature over the exact bytes", () => {
    expect(
      verifySshSig({ message, armoredSignature: sign(message), allowedSigners: signers, principal: "sean" }),
    ).toBe(true);
  });

  it("rejects the same signature against different bytes — the replay property", () => {
    const other = '{"actionType":"done","issueRef":"SYD-43","v":1}';
    expect(
      verifySshSig({ message: other, armoredSignature: sign(message), allowedSigners: signers, principal: "sean" }),
    ).toBe(false);
  });

  it("rejects a signature made in another namespace", () => {
    expect(
      verifySshSig({
        message,
        armoredSignature: sign(message, "git"),
        allowedSigners: signers,
        principal: "sean",
      }),
    ).toBe(false);
  });

  it("rejects an unknown principal", () => {
    expect(
      verifySshSig({ message, armoredSignature: sign(message), allowedSigners: signers, principal: "mallory" }),
    ).toBe(false);
  });

  it("rejects a garbage signature blob", () => {
    expect(
      verifySshSig({ message, armoredSignature: "not a signature", allowedSigners: signers, principal: "sean" }),
    ).toBe(false);
  });
});
