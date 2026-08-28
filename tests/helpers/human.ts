import type { Db } from "../../src/db/index.js";
import { createActor } from "../../src/services/actors.js";
import { requireHuman, type HumanActor } from "../../src/services/principal.js";
import { NO_SESSION } from "../../src/services/attribution.js";

/**
 * A human actor for tests, minted through the SAME accessor production uses.
 *
 * SYD-281 deliberately gives tests no `as HumanActor` escape hatch: a cast in a
 * test is how "tests construct state the producer never produces" gets started,
 * and this project has already paid for that once (SYD-280 shipped inert because
 * its tests called `upsertPrState` directly while production never did). Going
 * through `requireHuman` means a test can only hold a `HumanActor` under exactly
 * the conditions production can.
 */
export function createHuman(db: Db, name: string): HumanActor {
  return createHumanWithToken(db, name).actor;
}

/** As `createHuman`, for tests that also need the actor's bearer token. */
export function createHumanWithToken(db: Db, name: string): { actor: HumanActor; token: string } {
  const { actor, token } = createActor(db, { name, type: "human" });
  return { actor: requireHuman(actor, NO_SESSION, "act as a human in a test"), token };
}
