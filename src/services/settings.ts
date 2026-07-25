import { eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/index.js";
import { STATUSES, type Status } from "../db/schema.js";
import { settings } from "../db/schema.js";
import { boardColumnCounts, type BoardColumnCounts } from "./board-column-counts.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";

type SettingType = "string" | "number" | "string[]" | "boolean";

type ValueOfType<T extends SettingType> = T extends "number"
  ? number
  : T extends "boolean"
    ? boolean
    : T extends "string[]"
      ? string[]
      : string;

type RegistryEntry<T extends SettingType = SettingType> = {
  type: T;
  default: ValueOfType<T>;
  description?: string;
};

// Compile-time source of truth for what settings exist (SYD-154 design spec
// §Settings registry). Nothing reads the `settings` table directly — every
// consumer goes through getSetting/getAllSettings below. A fresh DB (zero
// rows) behaves exactly like today: every key resolves to its default.
export const REGISTRY = {
  "instance.base_url": {
    type: "string",
    default: "http://localhost:3300",
    description: "Base URL used in login links and outbound payloads",
  },
  "instance.name": { type: "string", default: "Switchyard" },
  "sessions.stale_seconds": { type: "number", default: 12 * 3600 },
  "claims.stale_seconds": { type: "number", default: 4 * 3600 },
  "claims.deviation_seconds": { type: "number", default: 3600 },
  "claims.lease_ttl_seconds": { type: "number", default: 8 * 3600 },
  // SYD-210 Layer B: a heartbeat renews a lease to now + this window (= the
  // host worker's N missed beats x interval, 10 x 60s). Shorter than the mint
  // TTL, so a heartbeated (container) claim gets honest ~10-min liveness while
  // an un-heartbeated (interactive) claim keeps the long lease_ttl_seconds.
  // Also the server-uptime grace after a redeploy before expiry may resume.
  "claims.heartbeat_window_seconds": { type: "number", default: 600 },
  "auth.login_link_ttl_seconds": { type: "number", default: 15 * 60 },
  "webhooks.suppressed_events": { type: "string[]", default: ["progress_note"] },
  "dispatch.max_concurrent": { type: "number", default: 1 },
  "dispatch.max_answer_concurrent": { type: "number", default: 2 },
  "dispatch.poll_seconds": { type: "number", default: 300 },
  "dispatch.event_poll_seconds": { type: "number", default: 15 },
  "supervised.hard_gate_actions": {
    type: "string[]",
    default: ["done"],
    description:
      "Actions requiring fresh human affirmation in a supervised session before they execute. Only affirmable actions are allowed (done, dependency.remove). Empty = full absorption.",
  },
  "wip.limit.backlog": { type: "number", default: 0 },
  "wip.limit.todo": { type: "number", default: 0 },
  "wip.limit.in_progress": { type: "number", default: 0 },
  "wip.limit.in_review": { type: "number", default: 5 },
  // Phase 2 (affirmation relay). When true, POST /api/pending-actions/:id/affirm
  // (the Phase 1 cookie click) is refused and only a signed affirmation releases
  // a gated action. Default false: merging Phase 2 changes nothing until this is
  // deliberately switched on. Leaving the click enabled alongside signatures
  // would BE the break-glass the design rejected — one gate, one strength.
  "supervised.affirm_requires_signature": {
    type: "boolean",
    default: false,
    description:
      "Require a hardware-signed affirmation (ssh-keygen -Y sign against an enrolled FIDO key) to release a gated action. When true, the web Approve button is refused.",
  },
  // Short by design: an affirmation that outlives the human's attention is a
  // bearer token with extra steps. Signed into the canonical doc, so it cannot
  // be extended after the fact.
  "supervised.affirm_ttl_seconds": {
    type: "number",
    default: 300,
    description: "How long a parked action stays affirmable before it expires.",
  },
} satisfies Record<string, RegistryEntry>;

// The gated actions an affirmation can actually carry out. Gating anything else
// would strand the proposal: the divert would park a pending row that
// affirmPendingAction has no executor for. Lives here rather than in
// hard-gate.ts (which re-exports it as its public name) to keep settings.ts a
// leaf — hard-gate.ts imports getSetting and updateIssue, so importing it back
// would close a settings -> hard-gate -> issues -> settings cycle.
export const EXECUTABLE_GATE_ACTIONS: readonly string[] = ["done", "dependency.remove"];

export type SettingKey = keyof typeof REGISTRY;

type SettingValue<K extends SettingKey> = ValueOfType<(typeof REGISTRY)[K]["type"]>;

export type SettingView = {
  key: SettingKey;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  description: string | null;
};

function requireHuman(actor: Actor): void {
  if (actor.type !== "human") {
    throw new SwitchyardError(
      "Settings are human-only — ask a human to change instance config or dispatch policy.",
    );
  }
}

function requireKnownKey(key: string): asserts key is SettingKey {
  if (!(key in REGISTRY)) {
    throw new SwitchyardError(
      `Unknown setting "${key}" — see GET /api/settings for the list of valid keys.`,
    );
  }
}

function validateValue(key: SettingKey, value: unknown): void {
  const entry = REGISTRY[key] as RegistryEntry;
  if (entry.type === "string") {
    if (typeof value !== "string" || value.length === 0) {
      throw new SwitchyardError(`Setting "${key}" must be a non-empty string.`);
    }
  } else if (entry.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0 ||
      (value === 0 && !key.startsWith("wip.limit."))
    ) {
      throw new SwitchyardError(
        `Setting "${key}" must be ${key.startsWith("wip.limit.") ? "a non-negative" : "a positive"} integer.`,
      );
    }
  } else if (entry.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new SwitchyardError(`Setting "${key}" must be true or false.`);
    }
  } else {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new SwitchyardError(`Setting "${key}" must be an array of strings.`);
    }
    // Write-path only (getSetting never re-validates), so tightening this can
    // never make an already-stored value unreadable.
    if (key === "supervised.hard_gate_actions") {
      const stranded = (value as string[]).filter((v) => !EXECUTABLE_GATE_ACTIONS.includes(v));
      if (stranded.length > 0) {
        throw new SwitchyardError(
          `"${stranded.join('", "')}" is not an affirmable action — a gated action needs an executor to run once a human affirms it. Valid: ${EXECUTABLE_GATE_ACTIONS.join(", ")}.`,
        );
      }
    }
  }
}

export function getSetting<K extends SettingKey>(db: DbOrTx, key: K): SettingValue<K> {
  requireKnownKey(key);
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return (row ? row.value : REGISTRY[key].default) as SettingValue<K>;
}

// Base URL for links we hand to humans (login links) and outbound payloads.
// Precedence: an explicit instance.base_url override in the DB wins, then the
// SWITCHYARD_URL env var as a deployment-level fallback, then the registry
// default. getSetting can't express this because an unset key already resolves
// to the default, which would shadow the env var.
export function resolveBaseUrl(db: Db): string {
  const row = db.select().from(settings).where(eq(settings.key, "instance.base_url")).get();
  if (row) return row.value as string;
  return process.env.SWITCHYARD_URL ?? REGISTRY["instance.base_url"].default;
}

export function getAllSettings(db: Db): SettingView[] {
  const overrides = new Map(
    db
      .select()
      .from(settings)
      .all()
      .map((r) => [r.key, r.value]),
  );
  return (Object.keys(REGISTRY) as SettingKey[]).map((key) => {
    const entry = REGISTRY[key] as RegistryEntry;
    const hasOverride = overrides.has(key);
    return {
      key,
      value: hasOverride ? overrides.get(key) : entry.default,
      default: entry.default,
      isDefault: !hasOverride,
      description: entry.description ?? null,
    };
  });
}

export function setSetting(db: Db, actor: Actor, key: string, value: unknown): SettingView {
  requireHuman(actor);
  requireKnownKey(key);
  validateValue(key, value);
  const entry = REGISTRY[key] as RegistryEntry;
  db.insert(settings)
    .values({ key, value, updatedByActorId: actor.id })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedByActorId: actor.id, updatedAt: Math.floor(Date.now() / 1000) },
    })
    .run();
  return {
    key,
    value,
    default: entry.default,
    isDefault: false,
    description: entry.description ?? null,
  };
}

export function resetSetting(db: Db, actor: Actor, key: string): SettingView {
  requireHuman(actor);
  requireKnownKey(key);
  const entry = REGISTRY[key] as RegistryEntry;
  db.delete(settings).where(eq(settings.key, key)).run();
  return {
    key,
    value: entry.default,
    default: entry.default,
    isDefault: true,
    description: entry.description ?? null,
  };
}

export type DispatchPolicy = {
  maxConcurrent: number;
  maxAnswerConcurrent: number;
  intervalSeconds: number;
  eventPollSeconds: number;
  // SYD-210 Layer B: the server's lease heartbeat window, so the host derives
  // its cancellation cadence (misses × interval) from the SAME value the server
  // expires and grace-gates on — they can't drift if an operator retunes it.
  heartbeatWindowSeconds: number;
  wipLimits: Partial<Record<Status, number>>;
  columnCounts: BoardColumnCounts;
};

// Worker-facing subset of the registry (GET /api/dispatch-policy) — the only
// Settings read agent tokens may hit. Field names match WorkerConfig's policy
// fields (scripts/worker-select.ts) directly so a worker can overlay this
// response onto its config with no translation.
export function getDispatchPolicy(db: Db): DispatchPolicy {
  const wipLimits = Object.fromEntries(
    STATUSES.flatMap((status) => {
      const key = `wip.limit.${status}`;
      return key in REGISTRY ? [[status, getSetting(db, key as SettingKey)]] : [];
    }),
  ) as Partial<Record<Status, number>>;
  return {
    maxConcurrent: getSetting(db, "dispatch.max_concurrent"),
    maxAnswerConcurrent: getSetting(db, "dispatch.max_answer_concurrent"),
    intervalSeconds: getSetting(db, "dispatch.poll_seconds"),
    eventPollSeconds: getSetting(db, "dispatch.event_poll_seconds"),
    heartbeatWindowSeconds: getSetting(db, "claims.heartbeat_window_seconds"),
    wipLimits,
    columnCounts: boardColumnCounts(db),
  };
}
