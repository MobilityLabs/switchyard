import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { openDb } from "../../src/db/index.js";

describe("supervised-session schema", () => {
  it("sessions has kind, via_agent_id, closed_at", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(
      sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('th',1,2,'supervised',9999999999)`,
    );
    const row = db.get<{ kind: string; via_agent_id: number; closed_at: number | null }>(
      sql`SELECT kind, via_agent_id, closed_at FROM sessions`,
    );
    expect(row!.kind).toBe("supervised");
    expect(row!.via_agent_id).toBe(2);
    expect(row!.closed_at).toBeNull();
  });

  it("pending_actions enforces one active row per (session,issue,action)", () => {
    const db = openDb(":memory:");
    db.run(sql`INSERT INTO actors (name,type) VALUES ('h','human'),('a','agent')`);
    db.run(
      sql`INSERT INTO sessions (token_hash,actor_id,via_agent_id,kind,expires_at) VALUES ('th',1,2,'supervised',9999999999)`,
    );
    db.run(sql`INSERT INTO projects (key,name) VALUES ('SYD','Switchyard')`);
    db.run(
      sql`INSERT INTO issues (project_id,number,title,status,creator_id) VALUES (1,1,'t','backlog',1)`,
    );
    db.run(
      sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`,
    );
    // a second *pending* row for the same tuple must violate the partial unique index
    expect(() =>
      db.run(
        sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`,
      ),
    ).toThrow();
    // but an affirmed row for the same tuple is allowed (predicate is status='pending')
    db.run(sql`UPDATE pending_actions SET status='affirmed' WHERE id=1`);
    expect(() =>
      db.run(
        sql`INSERT INTO pending_actions (session_id,issue_id,action_type,payload,status) VALUES (1,1,'done','{}','pending')`,
      ),
    ).not.toThrow();
  });
});
