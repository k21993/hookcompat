#!/usr/bin/env node
// hookcompat capture hook.
//
// Registered for every event a scenario records. For each invocation it:
//   1. writes the stdin payload to <captureDir>/<ts>-<uuid>-<event>.json (unique name, no shared counter),
//   2. appends one line to <captureDir>/evidence.jsonl saying what it answered,
//   3. answers with the decision the scenario asks for (default: no opinion).
//
// Usage: node capture.mjs <captureDir> <respondJsonPath>
// No dependencies: it runs inside the CLI under test.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_STDIN_BYTES = 8 * 1024 * 1024;

const [captureDir, respondPath] = process.argv.slice(2);
if (!captureDir || !respondPath) {
  process.stderr.write("hookcompat capture: usage: capture.mjs <captureDir> <respondJsonPath>\n");
  // Exit 0: a broken capture hook must never block the agent. The missing capture shows up in the run report.
  process.exit(0);
}

const chunks = [];
let size = 0;
let truncated = false;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_STDIN_BYTES) {
    truncated = true;
    break;
  }
  chunks.push(chunk);
}
const stdin = Buffer.concat(chunks).toString("utf8");

let payload;
try {
  payload = JSON.parse(stdin);
} catch {
  payload = undefined;
}

const event = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "unknown";
const receivedAt = new Date().toISOString();
const invocationId = `${receivedAt.replace(/[:.]/g, "")}-${randomUUID()}`;

let respondMap = {};
try {
  respondMap = JSON.parse(readFileSync(respondPath, "utf8"));
} catch {
  respondMap = {};
}

// Hook output per event. Only events with a known response format can answer;
// anything else is recorded as "none" so the evidence matches what was actually sent.
const encoders = {
  PreToolUse: (d) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: "hookcompat reference hook" } }),
  PermissionRequest: (d) =>
    d === "allow" || d === "deny" ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: d } } } : undefined,
};
const wanted = respondMap[event] ?? "none";
const output = wanted === "none" ? undefined : encoders[event]?.(wanted);
const responded = output ? wanted : "none";

writeFileSync(
  join(captureDir, `${invocationId}-${event}.json`),
  JSON.stringify(
    payload === undefined
      ? { invocationId, receivedAt, event, rawStdin: stdin, stdinTruncated: truncated }
      : { invocationId, receivedAt, event, payload, stdinTruncated: truncated },
  ),
);

appendFileSync(
  join(captureDir, "evidence.jsonl"),
  JSON.stringify({
    invocationId,
    receivedAt,
    event,
    tool: typeof payload?.tool_name === "string" ? payload.tool_name : undefined,
    responded,
  }) + "\n",
);

if (output) process.stdout.write(JSON.stringify(output));
process.exit(0);
