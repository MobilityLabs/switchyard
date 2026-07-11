import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";
import type { Actor } from "./actors.js";
import { SwitchyardError } from "./errors.js";

type SettingType = "string" | "number" | "string[]";

type ValueOfType<T extends SettingType> = T extends "number"
  ? number
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
  "auth.login_link_ttl_seconds": { type: "number", default: 15 * 60 },
  "webhooks.suppressed_events": { type: "string[]", default: ["progress_note"] },
  "dispatch.max_concurrent": { type: "number", default: 1 },
  "dispatch.max_answer_concurrent": { type: "number", default: 2 },
  "dispatch.poll_seconds": { type: "number", default: 300 },
  "dispatch.event_poll_seconds": { type: "number", default: 15 },
} satisfies Record<string, RegistryEntry>;

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
  if (actor.type === "agent") {
    throw new SwitchyardError(
      "Settings are human-only — ask a human to change instance config or dispatch policy."
    );
  }
}

function requireKnownKey(key: string): asserts key is SettingKey {
  if (!(key in REGISTRY)) {
    throw new SwitchyardError(
      `Unknown setting "${key}" — see GET /api/settings for the list of valid keys.`
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
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new SwitchyardError(`Setting "${key}" must be a positive integer.`);
    }
  } else {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new SwitchyardError(`Setting "${key}" must be an array of strings.`);
    }
  }
}

export function getSetting<K extends SettingKey>(db: Db, key: K): SettingValue<K> {
  requireKnownKey(key);
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return (row ? row.value : REGISTRY[key].default) as SettingValue<K>;
}

export function getAllSettings(db: Db): SettingView[] {
  const overrides = new Map(db.select().from(settings).all().map((r) => [r.key, r.value]));
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
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedByActorId: actor.id, updatedAt: Math.floor(Date.now() / 1000) } })
    .run();
  return { key, value, default: entry.default, isDefault: false, description: entry.description ?? null };
}

export function resetSetting(db: Db, actor: Actor, key: string): SettingView {
  requireHuman(actor);
  requireKnownKey(key);
  const entry = REGISTRY[key] as RegistryEntry;
  db.delete(settings).where(eq(settings.key, key)).run();
  return { key, value: entry.default, default: entry.default, isDefault: true, description: entry.description ?? null };
}
