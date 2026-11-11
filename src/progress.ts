/**
 * What a reviewer's pane shows while it works: one line per tool call, the model's prose as each
 * message ends, and failures. The pane is only for watching; nothing reads this output. Every string
 * may come from the repository, so control characters are stripped before anything reaches the terminal.
 */
type Event =
  | { type: "tool_execution_start"; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolName: string; isError: boolean }
  | { type: "message_end"; message: { role: string; content?: unknown; stopReason?: string; errorMessage?: string } }
  | { type: string };

const TEXT_LIMIT = 600;

/** Terminal-safe text: no escape sequences or other control characters, newlines kept only when asked. */
export function clean(text: string, keepNewlines = false): string {
  return text.replace(keepNewlines ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, " ");
}

const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The one argument worth showing for each review tool. */
function argument(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (tool) {
    case "read_review_diff": return a.start ? `from line ${a.start}` : "";
    case "read_snapshot": return `${a.path ?? ""}${a.side ? ` (${a.side})` : ""}${a.start ? ` from line ${a.start}` : ""}`;
    case "search_snapshot": return `"${a.query ?? ""}"${a.side ? ` (${a.side})` : ""}`;
    case "review_changes": case "list_snapshot": return a.offset ? `from ${a.offset}` : "";
    case "cannot_complete_review": return String(a.reason ?? "");
    default: return "";
  }
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(c => c && c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
}

/** The line a session event adds to the pane, or undefined when it adds none. */
export function progressLine(event: Event): string | undefined {
  if (event.type === "tool_execution_start" && "toolName" in event) {
    const arg = cut(clean(argument(event.toolName, "args" in event ? event.args : undefined)), 160);
    return `→ ${clean(event.toolName)}${arg ? ` ${arg}` : ""}`;
  }
  if (event.type === "tool_execution_end" && "isError" in event) {
    return event.isError ? `✗ ${clean(event.toolName)} failed` : event.toolName === "submit_review" ? "✓ review submitted" : undefined;
  }
  if (event.type === "message_end" && "message" in event && event.message.role === "assistant") {
    if (event.message.stopReason === "error") return `! model error: ${clean(event.message.errorMessage ?? "request failed")}`;
    const prose = clean(text(event.message.content), true).trim();
    return prose ? `\n${cut(prose, TEXT_LIMIT)}\n` : undefined;
  }
  return undefined;
}
