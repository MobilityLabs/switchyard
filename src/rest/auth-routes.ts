import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "../db/index.js";
import { SwitchyardError } from "../services/errors.js";
import { createLoginLink, redeemLoginLink, deleteSession } from "../services/auth.js";

export const SESSION_COOKIE = "switchyard_session";

export function buildAuthRoutes(db: Db) {
  const app = new Hono();

  app.get("/auth/login", (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token query parameter." }, 400);
    try {
      const { sessionToken } = redeemLoginLink(db, token);
      setCookie(c, SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 30 * 24 * 3600,
        secure: process.env.SWITCHYARD_COOKIE_SECURE === "1",
      });
      // Redirect immediately so the token doesn't linger in browser history
      // or get replayed via Referer on whatever page loads next — the
      // server access log for this request is the only place it's still
      // visible, mitigated by single-use + the 15-min TTL.
      return c.redirect("/", 302);
    } catch (err) {
      if (err instanceof SwitchyardError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.post("/auth/logout", (c) => {
    const st = getCookie(c, SESSION_COOKIE);
    if (st) deleteSession(db, st);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
