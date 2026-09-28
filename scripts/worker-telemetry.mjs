// Shared by host, container CLI wrapper, and isolated SDK runner. Never serialize
// provider events wholesale: MCP arguments/results and auth objects may be secret.
export function isValidWorkerModel(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

export function resolveWorkerModel(config, project) {
  const model = project?.model ?? config.model;
  if (model !== undefined && !isValidWorkerModel(model)) {
    throw new Error("model must be a valid model identifier");
  }
  return model;
}

export function buildEngineArgs(engine, args, model) {
  if (model !== undefined && !isValidWorkerModel(model)) {
    throw new Error("model must be a valid model identifier");
  }
  const modelArgs = model === undefined ? [] : ["--model", model];
  if (engine === "claude")
    return [...args, "--output-format", "stream-json", "--verbose", ...modelArgs];
  if (engine === "codex") return ["exec", "--json", ...modelArgs, ...args];
  if (engine === "gemini") return [...args, "--output-format", "stream-json", ...modelArgs];
  throw new Error("unsupported worker engine");
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : undefined;
const numericKeys = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "input",
  "output",
  "cached",
  "thoughts",
  "tool",
  "total",
];

/** A bounded, credential-free event envelope. Unknown schemas retain only their
 * type; missing actual model stays missing, even when a requested model is set. */
export function normalizeProviderEvent(engine, event) {
  if (!object(event) || !identifier(event.type)) return null;
  const out = { type: "worker.event", engine, event_type: identifier(event.type) };
  for (const field of ["subtype", "status"]) {
    if (identifier(event[field])) out[field] = event[field];
  }
  const reportedVersion = parseRuntimeVersion(event.claude_code_version);
  if (reportedVersion) out.cli_version = reportedVersion;
  const models = new Set();
  // These are provider-emitted values, not defaults or the configured request.
  for (const value of [event.model, event.message?.model]) {
    if (isValidWorkerModel(value)) models.add(value);
  }
  for (const source of [event.modelUsage, event.stats?.models]) {
    if (object(source))
      for (const model of Object.keys(source).slice(0, 32)) {
        if (isValidWorkerModel(model)) models.add(model);
      }
  }
  if (models.size) out.effective_models = [...models];
  const usage = event.usage ?? event.message?.usage ?? event.stats?.tokens;
  if (object(usage)) {
    const counts = {};
    for (const key of numericKeys) {
      if (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0)
        counts[key] = usage[key];
    }
    if (Object.keys(counts).length) out.usage = counts;
  }
  for (const key of [
    "duration_ms",
    "duration_api_ms",
    "total_cost_usd",
    "num_turns",
    "exit_code",
  ]) {
    if (typeof event[key] === "number" && Number.isFinite(event[key])) out[key] = event[key];
  }
  if (typeof event.is_error === "boolean") out.is_error = event.is_error;
  if (identifier(event.item?.type)) out.item_type = event.item.type;
  if (identifier(event.item?.status)) out.item_status = event.item.status;
  if (typeof event.item?.exit_code === "number" && Number.isFinite(event.item.exit_code))
    out.exit_code = event.item.exit_code;
  const toolNames = (Array.isArray(event.message?.content) ? event.message.content : [])
    .filter((item) => item?.type === "tool_use" && identifier(item.name))
    .slice(0, 32)
    .map((item) => item.name);
  if (identifier(event.tool_name)) toolNames.push(event.tool_name);
  if (toolNames.length) out.tool_names = [...new Set(toolNames)];
  // Do not copy error messages, tool arguments/results, auth, session IDs, or
  // arbitrary keys. A provider can echo credentials in all of those fields.
  if (identifier(event.error?.code)) out.error_code = event.error.code;
  const diagnostic = classifyWorkerDiagnostic(
    event.error?.message ?? (event.type === "error" ? event.message : undefined),
  );
  if (diagnostic) out.diagnostic = diagnostic;
  return out;
}

export function parseProviderLine(engine, line) {
  try {
    return normalizeProviderEvent(engine, JSON.parse(line));
  } catch {
    return null;
  }
}

/** --version may include a product name. Extract the version, never log the
 * whole subprocess output (which can contain diagnostics or environment data). */
export function parseRuntimeVersion(output) {
  return typeof output === "string"
    ? (output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0] ?? null)
    : null;
}

/** Classify text without persisting it: provider stderr can contain complete
 * authorization headers and echoed request payloads. Messages are static. */
export function classifyWorkerDiagnostic(text) {
  if (typeof text !== "string") return null;
  const patterns = [
    [
      /unknown (?:option|argument)|unrecognized (?:option|argument)|unexpected argument|invalid argument/i,
      "invalid_arguments",
      "Check the installed CLI version and supported worker flags.",
    ],
    [
      /unauthori[sz]ed|authentication|invalid.{0,20}(?:api.?key|token)|401|403/i,
      "authentication",
      "Check provider authentication and the credential-injecting proxy.",
    ],
    [/rate.?limit|quota|429/i, "rate_limit", "Check provider quota and retry policy."],
    [
      /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|connection|timed? ?out/i,
      "connection",
      "Check provider connectivity, allowed domains, and the egress proxy.",
    ],
    [
      /permission denied|EACCES/i,
      "permission",
      "Check worker executable and workspace permissions.",
    ],
    [/mcp/i, "mcp", "Check MCP endpoint connectivity and session lease configuration."],
  ];
  for (const [pattern, code, message] of patterns) {
    if (pattern.test(text)) return { code, message };
  }
  return null;
}
