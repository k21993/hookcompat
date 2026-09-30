#!/usr/bin/env node
// A stand-in CLI for testing the recorder pipeline without spending tokens.
// It reads a Claude-style hooks config and invokes the hooks with canned payloads.
// It does not reflect how the real Claude Code or Codex behave.
//
// Usage: fake-cli.mjs --version
//        fake-cli.mjs --config <hooks.json> --marker <file> --prompt <text>

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "boolean", default: false },
    config: { type: "string" },
    marker: { type: "string" },
    prompt: { type: "string" },
  },
});
if (values.version) {
  console.log("0.0.1 (fake)");
  process.exit(0);
}

const config = JSON.parse(readFileSync(values.config, "utf8"));
const cwd = process.cwd();
const common = {
  session_id: "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b",
  transcript_path: join(process.env.HOME, ".fake", "transcript.jsonl"),
  cwd,
  permission_mode: "default",
  model: "fake-model-1",
};

function fire(event, extra) {
  const outputs = [];
  for (const entry of config.hooks[event] ?? []) {
    for (const hook of entry.hooks) {
      const input = JSON.stringify({ ...common, hook_event_name: event, ...extra });
      try {
        outputs.push({ code: 0, stdout: execSync(hook.command, { input, encoding: "utf8", shell: "/bin/sh" }) });
      } catch (err) {
        outputs.push({ code: err.status ?? 1, stdout: err.stdout ?? "" });
      }
    }
  }
  return outputs;
}

fire("SessionStart", { source: "startup" });
fire("UserPromptSubmit", { prompt: values.prompt });

const toolInput = { command: `echo hookcompat > ${values.marker}`, description: "Write marker" };
const pre = fire("PreToolUse", { tool_name: "Bash", tool_input: toolInput, tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv" });
const denied = pre.some(
  (o) => o.code === 2 || (o.stdout && JSON.parse(o.stdout)?.hookSpecificOutput?.permissionDecision === "deny"),
);
if (!denied) {
  writeFileSync(join(cwd, values.marker), "hookcompat\n");
  fire("PostToolUse", {
    tool_name: "Bash",
    tool_input: toolInput,
    tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
    tool_response: { stdout: "", stderr: "", interrupted: false },
  });
}
fire("Stop", { stop_hook_active: false });
