import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBounded } from "../../proc.js";
import { hooksObject, installFromNpm, onPath, readVersion } from "./common.js";
import type { HarnessAdapter } from "./types.js";

/**
 * Claude Code, run headless with `claude -p`.
 * Documented (code.claude.com/docs/en/hooks, checked 2026-09-30): hooks run in -p mode, and
 * `--settings <file>` takes precedence over project settings. Verify on day 1 against a real run.
 */
export const claudeCode: HarnessAdapter = {
  id: "claude-code",
  credentialEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],

  async resolve(sb, version) {
    return version ? installFromNpm(sb, "@anthropic-ai/claude-code", version, "claude") : onPath("claude");
  },

  version: readVersion,

  writeHookConfig(sb, hooks) {
    const path = join(sb.root, "claude-settings.json");
    const content = JSON.stringify(hooksObject(hooks, 30), null, 2);
    writeFileSync(path, content);
    return { path, content };
  },

  async run(cli, sb, env, config, opts) {
    const argv = [
      ...cli,
      "-p",
      opts.prompt,
      "--settings",
      config.path,
      "--max-turns",
      "3",
      "--allowedTools",
      "Bash",
      "--output-format",
      "stream-json",
      "--verbose",
      "--debug-file",
      join(sb.logDir, "claude-debug.log"),
      ...(opts.model ? ["--model", opts.model] : []),
      ...opts.extraArgs,
    ];
    const result = await runBounded({ argv, cwd: sb.repo, env, timeoutMs: opts.timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
    return { argv, result };
  },
};
