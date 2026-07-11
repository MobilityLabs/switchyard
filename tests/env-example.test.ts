import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// SYD-141: .env.example documents the server's config surface. This guards
// against drift -- a new process.env.FOO in src/ with no matching entry here
// would silently reintroduce the "grep process.env to find the config
// surface" problem the issue was filed to fix.

const REPO_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_DIR, "src");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function envVarsReadIn(files: string[]): Set<string> {
  const vars = new Set<string>();
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      vars.add(match[1]);
    }
  }
  return vars;
}

describe(".env.example", () => {
  it("documents every process.env var read under src/", () => {
    const used = envVarsReadIn(tsFilesUnder(SRC_DIR));
    const example = readFileSync(path.join(REPO_DIR, ".env.example"), "utf8");
    const documented = new Set(
      [...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1])
    );

    for (const name of used) {
      expect(documented.has(name), `${name} is read in src/ but missing from .env.example`).toBe(true);
    }
  });
});
