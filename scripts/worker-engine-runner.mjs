// No provider call is made by --version. Session arguments are arrays, never a
// shell command. This wrapper is baked into images and also used on the host.
import { spawn, execFileSync } from "node:child_process";
import {
  buildEngineArgs,
  parseProviderLine,
  parseRuntimeVersion,
  classifyWorkerDiagnostic,
} from "./worker-telemetry.mjs";

const [engine, ...baseArgs] = process.argv.slice(2);
const requestedModel = process.env.WORKER_MODEL || undefined;
let args;
try {
  args = buildEngineArgs(engine, baseArgs, requestedModel);
} catch {
  process.stderr.write("[worker] invalid engine or model configuration\n");
  process.exit(2);
}
const sessionKey = /^[a-f0-9-]{36}$/.test(process.env.WORKER_SESSION_KEY ?? "")
  ? process.env.WORKER_SESSION_KEY
  : undefined;
const emit = (event) =>
  process.stdout.write(`${JSON.stringify({ session_key: sessionKey, ...event })}\n`);
let version = null;
try {
  version = parseRuntimeVersion(
    execFileSync(engine, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16384,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  /* version unavailable is not an invented default */
}
emit({
  type: "worker.runtime",
  engine,
  requested_model: requestedModel ?? null,
  cli_version: version,
  started_at: new Date().toISOString(),
});
let child;
try {
  child = spawn(engine, args, { stdio: ["ignore", "pipe", "pipe"] });
} catch {
  emit({
    type: "worker.launch_error",
    engine,
    code: "launch_failed",
    message: "Check the CLI executable and worker configuration.",
  });
  process.exit(127);
}
let launchFailed = false;
let stopping = false;
let forceStop;
const diagnostics = new Set();
// Bounded line buffers avoid a malicious/verbose tool exhausting host memory.
// Unstructured output is counted, not persisted: arbitrary stderr may contain
// auth headers. Provider event envelopes retain useful status/usage metadata.
for (const [stream, source] of [
  [child.stdout, "stdout"],
  [child.stderr, "stderr"],
]) {
  let buffer = "";
  let dropping = false;
  let omitted = 0;
  stream.setEncoding("utf8");
  const consume = (line) => {
    const event = source === "stdout" ? parseProviderLine(engine, line) : null;
    if (event) emit(event);
    else if (line) {
      omitted++;
      const diagnostic = classifyWorkerDiagnostic(line);
      if (diagnostic && !diagnostics.has(diagnostic.code)) {
        diagnostics.add(diagnostic.code);
        emit({ type: "worker.diagnostic", engine, ...diagnostic });
      }
    }
  };
  stream.on("data", (chunk) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) buffer += part;
      if (buffer.length > 1024 * 1024) {
        buffer = "";
        dropping = true;
      }
      if (part.endsWith("\n")) {
        if (dropping) omitted++;
        else consume(buffer.trimEnd());
        buffer = "";
        dropping = false;
      }
    }
  });
  stream.on("end", () => {
    if (dropping) omitted++;
    else if (buffer) consume(buffer);
    if (omitted) emit({ type: "worker.output_omitted", stream: source, lines: omitted });
  });
}
// The host starts this wrapper as a process-group leader. Keep the CLI and
// its tools in that group so host cancellation can reach every descendant.
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    try {
      process.kill(-process.pid, signal);
    } catch {
      /* container: Docker owns the process boundary */
    }
    forceStop = setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 3000);
    // Keep the wrapper alive for the grace period even if the CLI exits first:
    // ignored-stdio tool descendants may still need the group SIGKILL.
  });
child.on("spawn", () => process.send?.({ type: "worker.provider_started" }));
child.on("error", (error) => {
  process.send?.({ type: "worker.launch_error" });
  launchFailed = true;
  emit({
    type: "worker.launch_error",
    engine,
    code: ["ENOENT", "EACCES"].includes(error.code) ? error.code : "launch_failed",
    message: "Check that the CLI is installed and executable on the worker PATH.",
  });
  process.exitCode = 127;
});
child.on("close", (code, signal) => {
  if (forceStop && !stopping) clearTimeout(forceStop);
  emit({ type: "worker.exit", engine, code: launchFailed ? 127 : code, signal });
  process.exitCode = launchFailed ? 127 : code !== null && code >= 0 ? code : 1;
});
