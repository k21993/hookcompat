import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../../proc.js";
import { hooksObject, installFromNpm, onPath, readVersion } from "./common.js";
import type { HarnessAdapter } from "./types.js";

/**
 * Codex, run headless with `codex exec`.
 * Documented (learn.chatgpt.com/docs/hooks, checked 2026-09-30): project hooks live in <repo>/.codex/hooks.json,
 * untrusted hooks are skipped unless `--dangerously-bypass-hook-trust` is passed, timeouts are in seconds.
 * Not documented: whether hooks fire under `codex exec`. The day-1 run checks this.
 */
export const codex: HarnessAdapter = {
  id: "codex",
  credentialEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],

  async resolve(sb, version) {
    return version ? installFromNpm(sb, "@openai/codex", version, "codex") : onPath("codex");
  },

  version: readVersion,

  writeHookConfig(sb, hooks) {
    const dir = join(sb.repo, ".codex");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "hooks.json");
    const content = JSON.stringify(hooksObject(hooks, 30), null, 2);
    writeFileSync(path, content);
    return { path, content };
  },

  async run(cli, sb, env, _config, opts) {
    const codexHome = join(sb.home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    // Users signed in with ChatGPT rather than an API key can opt in to copying their auth file.
    const authFile = join(homedir(), ".codex", "auth.json");
    if (process.env.HOOKCOMPAT_COPY_CODEX_AUTH === "1" && existsSync(authFile)) {
      copyFileSync(authFile, join(codexHome, "auth.json"));
    }
    const argv = [
      ...cli,
      "exec",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      ...(opts.model ? ["--model", opts.model] : []),
      ...opts.extraArgs,
      opts.prompt,
    ];
    const result = await runBounded({
      argv,
      cwd: sb.repo,
      env: { ...env, CODEX_HOME: codexHome },
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    return { argv, result };
  },
};
