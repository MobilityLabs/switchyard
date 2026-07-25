import type { Actor } from "./actors.js";

/**
 * The acting identity behind a write. `actor` is always the accountable
 * root (a human for supervised sessions, the authenticated actor otherwise).
 * `viaAgent`/`sessionId` are set only when the write happened inside a
 * supervised session, and drive the dual-attribution fields on events
 * (src/db/schema.ts: events.viaAgentId/sessionId).
 */
export type Principal = { actor: Actor; viaAgent?: Actor; sessionId?: number };
