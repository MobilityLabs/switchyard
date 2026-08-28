import type { Principal } from "./principal.js";

export type Attribution = { viaAgentId?: number; sessionId?: number };

/**
 * "This caller has no supervised session" — said out loud.
 *
 * SYD-281 made `ctx: Attribution` a required parameter on every function that
 * asks who is acting, which forces the REST/CLI/worker sites that genuinely
 * have no session to pass an empty attribution. A lint rule banning a bare `{}`
 * with a two-line allowlist would have been abandoned on contact, so the rule
 * bans the literal and permits this constant instead.
 *
 * It is a LEGIBILITY control, not a security one: a caller that wrongly reaches
 * for NO_SESSION in a supervised path fails open exactly as `{}` would. What it
 * buys is that the wrong choice is a named, greppable token rather than two
 * invisible braces.
 */
export const NO_SESSION: Attribution = {};

export function attributionOf(p: Principal): Attribution {
  return { viaAgentId: p.viaAgent?.id, sessionId: p.sessionId };
}
