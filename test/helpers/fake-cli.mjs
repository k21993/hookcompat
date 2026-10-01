#!/usr/bin/env node
// A stand-in CLI for testing the recorder pipeline without spending tokens.
// It reads a Claude-style hooks config and invokes the hooks with canned payloads.
// It does not reflect how the real Claude Code or Codex behave.
//
// Usage: fake-cli.mjs --version
//        fake-cli.mjs --config <hooks.json> --marker <file> --prompt <text>

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const sessionId = "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b";
const common = {
  session_id: sessionId,
  // Same layout as Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session_id>.jsonl
  transcript_path: join(process.env.HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`),
  cwd,
  permission_mode: "default",
};
// Like Claude Code: the model is in the stream-json output, not in hook payloads.
console.log(JSON.stringify({ type: "system", subtype: "init", model: "fake-model-1" }));

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

// repo_files is fake-only, so tests can see what the sandbox repo contained.
fire("SessionStart", { source: "startup", repo_files: readdirSync(cwd, { recursive: true }).sort() });
// Test switches, set through the prompt text.
const huge = values.prompt.includes("fake:huge");
fire("UserPromptSubmit", { prompt: huge ? "x".repeat(9 * 1024 * 1024) : values.prompt });

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
if (values.prompt.includes("fake:sigterm")) process.kill(process.pid, "SIGTERM");
