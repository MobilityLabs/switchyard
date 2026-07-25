import type { Principal } from "./principal.js";

export type Attribution = { viaAgentId?: number; sessionId?: number };

export function attributionOf(p: Principal): Attribution {
  return { viaAgentId: p.viaAgent?.id, sessionId: p.sessionId };
}
