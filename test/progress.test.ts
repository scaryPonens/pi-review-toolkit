import test from "node:test";
import assert from "node:assert/strict";
import { clean, progressLine } from "../src/progress.js";

test("each tool call is one line naming what it reads", () => {
  assert.equal(progressLine({ type: "tool_execution_start", toolName: "read_snapshot", args: { path: "src/a.ts", side: "new", start: 40 } }), "→ read_snapshot src/a.ts (new) from line 40");
  assert.equal(progressLine({ type: "tool_execution_start", toolName: "search_snapshot", args: { query: "TERMS[", side: "new" } }), '→ search_snapshot "TERMS[" (new)');
  assert.equal(progressLine({ type: "tool_execution_start", toolName: "read_review_diff", args: {} }), "→ read_review_diff");
  assert.equal(progressLine({ type: "tool_execution_end", toolName: "read_snapshot", isError: false }), undefined);
  assert.equal(progressLine({ type: "tool_execution_end", toolName: "read_snapshot", isError: true }), "✗ read_snapshot failed");
  assert.equal(progressLine({ type: "tool_execution_end", toolName: "submit_review", isError: false }), "✓ review submitted");
});

test("the model's prose shows when a message ends, and a model error says so", () => {
  assert.equal(progressLine({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: " Checking parse.py. " }] } }), "\nChecking parse.py.\n");
  assert.equal(progressLine({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }] } }), undefined);
  assert.equal(progressLine({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }), "! model error: overloaded");
  assert.equal(progressLine({ type: "message_end", message: { role: "user", content: "hi" } }), undefined);
  assert.equal(progressLine({ type: "turn_start" }), undefined);
});

test("repository text cannot drive the terminal", () => {
  assert.equal(clean("a\x1b]52;c;evil\x07b\nc"), "a ]52;c;evil b c");
  assert.equal(clean("line1\nline2\x1b[2J", true), "line1\nline2 [2J");
  assert.equal(progressLine({ type: "tool_execution_start", toolName: "read_snapshot", args: { path: "x\x1b[31m.ts" } }), "→ read_snapshot x [31m.ts");
});
