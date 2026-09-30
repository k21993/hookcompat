import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface Sandbox {
  root: string;
  /** Throwaway HOME for the CLI under test. */
  home: string;
  /** Throwaway git repo the agent works in. */
  repo: string;
  captureDir: string;
  logDir: string;
  /** Absolute path of the capture hook copied into the sandbox. */
  captureHook: string;
  /** Fresh file name for this run's marker, relative to `repo`. */
  marker: string;
  cleanup(): void;
}

const CAPTURE_HOOK_SOURCE = fileURLToPath(new URL("../../hooks/capture.mjs", import.meta.url));

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "hookcompat-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const captureDir = join(root, "captures");
  const logDir = join(root, "logs");
  const binDir = join(root, "bin");
  for (const dir of [home, repo, captureDir, logDir, binDir]) mkdirSync(dir, { recursive: true });

  const captureHook = join(binDir, "capture.mjs");
  copyFileSync(CAPTURE_HOOK_SOURCE, captureHook);

  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hookcompat sandbox repo\n");

  return {
    root,
    home,
    repo,
    captureDir,
    logDir,
    captureHook,
    marker: `hookcompat-marker-${randomBytes(6).toString("hex")}.txt`,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Environment for the CLI under test: an explicit allowlist, never the full parent environment. */
export function sandboxEnv(sb: Sandbox, passThrough: string[]): { env: NodeJS.ProcessEnv; allowlist: string[] } {
  const allowlist = ["PATH", "LANG", "LC_ALL", "TERM", ...passThrough];
  const env: NodeJS.ProcessEnv = {
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, ".config"),
    XDG_CACHE_HOME: join(sb.home, ".cache"),
    XDG_DATA_HOME: join(sb.home, ".local", "share"),
    TMPDIR: join(sb.root, "tmp"),
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { env, allowlist };
}
