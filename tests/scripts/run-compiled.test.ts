import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let root: string;
const children: ReturnType<typeof spawn>[] = [];
const entries = ["agent-worker", "deliver", "github-poll"];

function write(relative: string, contents: string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "switchyard-compiled-"));
  write("package.json", '{"type":"module"}');
  write("package-lock.json", '{"lockfileVersion":3}');
  write("tsconfig.json", "{}");
  write("tsconfig.build.json", "{}");
  write("node_modules/typescript/package.json", '{"version":"1.0.0","type":"module"}');
  write("node_modules/typescript/lib/compiler.js", "// compiler implementation");
  write("src/value.ts", 'export const version = "v1";');
  for (const entry of entries) {
    write(
      `scripts/${entry}.ts`,
      `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
if (import.meta.url !== new URL("file://" + process.argv[1]).href) throw new Error("argv mismatch");
if (process.env.ENTRY_GATE) {
  writeFileSync(process.env.ENTRY_GATE + ".started", "ready");
  while (!existsSync(process.env.ENTRY_GATE)) await delay(10);
}
const { version } = await import("../src/value.js");
console.log("ENTRY:" + version + ":" + process.argv.slice(2).join(","));`,
    );
  }
  copyFileSync(
    new URL("../../scripts/run-compiled.mjs", import.meta.url),
    path.join(root, "scripts/run-compiled.mjs"),
  );
  // A controllable compiler subprocess exercises publication at the OS/process
  // boundary. It deliberately emits a partial tree before waiting or failing.
  write(
    "node_modules/typescript/bin/tsc",
    `import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const output = process.argv[process.argv.indexOf("--outDir") + 1];
appendFileSync("compilations.log", process.pid + "\\n");
mkdirSync(path.join(output, "scripts"), { recursive: true });
copyFileSync("scripts/agent-worker.ts", path.join(output, "scripts/agent-worker.js"));
if (existsSync("fail-compile")) process.exit(2);
if (process.env.COMPILE_GATE) {
  writeFileSync(process.env.COMPILE_GATE + "." + process.pid, "waiting");
  while (!existsSync(process.env.COMPILE_GATE)) await delay(10);
}
for (const entry of ["deliver", "github-poll"]) {
  copyFileSync("scripts/" + entry + ".ts", path.join(output, "scripts", entry + ".js"));
}
mkdirSync(path.join(output, "src"), { recursive: true });
copyFileSync("src/value.ts", path.join(output, "src/value.js"));`,
  );
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function launch(args = ["--build-only"], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [path.join(root, "scripts/run-compiled.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
  return { child, result };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for subprocess barrier");
    await delay(10);
  }
}

function buildInfo() {
  return JSON.parse(readFileSync(path.join(root, "dist/server/build-info.json"), "utf8")) as {
    sourceHash: string;
  };
}

function compilationCount() {
  return readFileSync(path.join(root, "compilations.log"), "utf8").trim().split("\n").length;
}

describe("compiled host launcher", () => {
  it("competing startups only import a complete generation and forward entry arguments", async () => {
    const gate = path.join(root, "compile-gate");
    const launches = entries.map((entry) => launch([entry, "--once"], { COMPILE_GATE: gate }));
    await until(
      () => readdirSync(root).filter((name) => name.startsWith("compile-gate.")).length === 3,
    );
    expect(existsSync(path.join(root, "dist/server/build-info.json"))).toBe(false);
    expect(launches.every(({ child }) => child.exitCode === null)).toBe(true);
    writeFileSync(gate, "release");
    for (const result of await Promise.all(launches.map(({ result }) => result))) {
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("ENTRY:v1:--once");
    }
    const hash = buildInfo().sourceHash;
    expect(readdirSync(path.join(root, "dist/server")).sort()).toEqual(
      ["build-info.json", hash].sort(),
    );
    expect((await launch().result).code).toBe(0);
    expect(compilationCount()).toBe(3); // unchanged startup is a cache hit
  });

  it("failed compilation preserves the prior complete build and never starts stale code", async () => {
    expect((await launch().result).code).toBe(0);
    const previous = readFileSync(path.join(root, "dist/server/build-info.json"), "utf8");
    const hash = buildInfo().sourceHash;
    const previousOutput = readFileSync(
      path.join(root, "dist/server", hash, "src/value.js"),
      "utf8",
    );
    write("src/value.ts", 'export const version = "v2";');
    write("fail-compile", "yes");
    const failed = await launch(["agent-worker"]).result;
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("tsc failed");
    expect(failed.output).not.toContain("ENTRY:");
    expect(readFileSync(path.join(root, "dist/server/build-info.json"), "utf8")).toBe(previous);
    expect(readFileSync(path.join(root, "dist/server", hash, "src/value.js"), "utf8")).toBe(
      previousOutput,
    );
    expect(
      readdirSync(path.join(root, "dist/server")).some((name) => name.startsWith(".building-")),
    ).toBe(false);
  });

  it("rebuilds when the dependency lock or installed compiler changes", async () => {
    expect((await launch().result).code).toBe(0);
    const hashes = new Set([buildInfo().sourceHash]);
    for (const [file, contents] of [
      ["package-lock.json", '{"lockfileVersion":3,"dependencies":{"new":"1"}}'],
      ["node_modules/.package-lock.json", '{"packages":{"typescript":{"version":"1.0.0"}}}'],
      ["node_modules/typescript/package.json", '{"version":"2.0.0","type":"module"}'],
      ["node_modules/typescript/lib/compiler.js", "// replaced compiler implementation"],
    ]) {
      write(file, contents);
      const result = await launch().result;
      expect(result.code, result.output).toBe(0);
      hashes.add(buildInfo().sourceHash);
    }
    expect(compilationCount()).toBe(5);
    expect(hashes.size).toBe(5);
  });

  it("copies imported MJS sidecars and rebuilds when their code or declarations change", async () => {
    write("scripts/telemetry/metadata.mjs", 'export const model = "first";');
    write("scripts/telemetry/metadata.d.mts", "export const model: string;");
    appendFileSync(
      path.join(root, "scripts/agent-worker.ts"),
      '\nconst { model } = await import("./telemetry/metadata.mjs");\nconsole.log("MODEL:" + model);',
    );
    const first = await launch(["agent-worker"]).result;
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("MODEL:first");
    const firstHash = buildInfo().sourceHash;

    write("scripts/telemetry/metadata.mjs", 'export const model = "second";');
    const second = await launch(["agent-worker"]).result;
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain("MODEL:second");
    const secondHash = buildInfo().sourceHash;
    expect(secondHash).not.toBe(firstHash);
    expect(
      readFileSync(
        path.join(root, "dist/server", firstHash, "scripts/telemetry/metadata.mjs"),
        "utf8",
      ),
    ).toContain('"first"');

    write("scripts/telemetry/metadata.d.mts", 'export const model: "second";');
    expect((await launch().result).code).toBe(0);
    expect(buildInfo().sourceHash).not.toBe(secondHash);
    const declarationHash = buildInfo().sourceHash;
    write("scripts/telemetry/commonjs.d.cts", "export const version: string;");
    expect((await launch().result).code).toBe(0);
    expect(buildInfo().sourceHash).not.toBe(declarationHash);
    expect(compilationCount()).toBe(4);
  });

  it("rejects inputs changed while compilation is in progress", async () => {
    expect((await launch().result).code).toBe(0);
    const previous = buildInfo();
    appendFileSync(path.join(root, "src/value.ts"), "\n// change before startup");
    const gate = path.join(root, "compile-gate");
    const compiling = launch(["--build-only"], { COMPILE_GATE: gate });
    await until(() => readdirSync(root).some((name) => name.startsWith("compile-gate.")));
    appendFileSync(path.join(root, "src/value.ts"), "\n// change during compile");
    writeFileSync(gate, "release");
    const result = await compiling.result;
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("compile inputs changed during the build");
    expect(buildInfo()).toEqual(previous);
  });

  it("keeps lazy imports on the generation selected by a running service", async () => {
    const gate = path.join(root, "entry-gate");
    const oldService = launch(["agent-worker"], { ENTRY_GATE: gate });
    await until(() => existsSync(`${gate}.started`));
    const oldInfo = buildInfo();
    const oldHash = oldInfo.sourceHash;
    write("src/value.ts", 'export const version = "v2";');
    const newService = await launch(["agent-worker"]).result;
    expect(newService.code, newService.output).toBe(0);
    expect(newService.output).toContain("ENTRY:v2:");
    expect(buildInfo().sourceHash).not.toBe(oldHash);
    writeFileSync(gate, "release");
    const oldResult = await oldService.result;
    expect(oldResult.code, oldResult.output).toBe(0);
    expect(oldResult.output).toContain("ENTRY:v1:");

    // Returning to old inputs selects the cached generation without compiling,
    // and refreshes the informational pointer while retaining original builtAt.
    write("src/value.ts", 'export const version = "v1";');
    expect((await launch().result).code).toBe(0);
    expect(buildInfo()).toEqual(oldInfo);
    expect(compilationCount()).toBe(2);
  });
});
