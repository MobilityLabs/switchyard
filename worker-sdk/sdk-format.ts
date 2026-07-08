// Dependency-free formatting of Claude Agent SDK stream messages into
// worker-log lines. Split from sdk-runner.ts so the main repo's tests can
// exercise it without worker-sdk/node_modules being installed.

type ContentBlock = { type: string; name?: string; text?: string };

/** The subset of an SDKMessage the formatter reads — structurally typed so
 * this file never imports the SDK. */
export type SdkEventLike = {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
};

/** One log line per interesting event; null for events not worth logging. */
export function formatSdkEvent(m: SdkEventLike): string | null {
  if (m.type === "system" && m.subtype === "init") return "[sdk] session started";

  if (m.type === "assistant") {
    const blocks = m.message?.content ?? [];
    const tools = blocks.filter((b) => b.type === "tool_use").map((b) => b.name ?? "?");
    if (tools.length > 0) return `[sdk] tool: ${tools.join(", ")}`;
    const text = blocks.find((b) => b.type === "text")?.text?.trim();
    if (text) return `[sdk] ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    return null;
  }

  if (m.type === "result") {
    const cost = m.total_cost_usd !== undefined ? ` cost=$${m.total_cost_usd.toFixed(4)}` : "";
    const turns = m.num_turns !== undefined ? ` turns=${m.num_turns}` : "";
    return `[sdk] result: ${m.subtype ?? "unknown"}${turns}${cost}`;
  }

  return null;
}
