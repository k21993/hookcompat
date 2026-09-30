import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runBounded } from "../../proc.js";
import type { Sandbox } from "../sandbox.js";
import type { HookEvent } from "../../schema.js";
import type { HookRegistration } from "./types.js";

export class InstallError extends Error {}

/** npm gets only what it needs to reach the registry, so install scripts never see API keys or other secrets. */
const NPM_ENV = ["PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "npm_config_registry"];
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Installs `<pkg>@<version>` into the sandbox and returns the path of its bin.
 * Install scripts stay on: Claude Code's postinstall fetches its native binary.
 */
export async function installFromNpm(sb: Sandbox, pkg: string, version: string, bin: string): Promise<string[]> {
  const prefix = join(sb.root, "cli");
  const env: NodeJS.ProcessEnv = { HOME: sb.home };
  for (const name of NPM_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  const res = await runBounded({
    argv: ["npm", "install", "--no-audit", "--no-fund", "--prefix", prefix, `${pkg}@${version}`],
    cwd: sb.root,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  if (res.timedOut) throw new InstallError(`npm install ${pkg}@${version} timed out`);
  if (res.exitCode !== 0) {
    throw new InstallError(`npm install ${pkg}@${version} failed: ${res.launchError ?? res.stderr.slice(-2000)}`);
  }
  return [join(prefix, "node_modules", ".bin", bin)];
}

export function onPath(bin: string): string[] {
  const found = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim();
  if (!found) throw new Error(`${bin} not found on PATH; pass --cli-version to install one`);
  return [found];
}

export async function readVersion(cli: string[], sb: Sandbox, env: NodeJS.ProcessEnv): Promise<string> {
  const res = await runBounded({
    argv: [...cli, "--version"],
    cwd: sb.repo,
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(res.stdout + res.stderr);
  if (!match) throw new Error(`could not read version from: ${res.stdout}${res.stderr}`);
  return match[0];
}

const TOOL_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "PermissionRequest"];

/**
 * Hook config shape shared by Claude Code settings and Codex hooks.json:
 * { hooks: { <Event>: [ { matcher?, hooks: [ { type: "command", command, timeout } ] } ] } }
 * Tool events get matcher "*" (match every tool); other events omit it.
 */
export function hooksObject(hooks: HookRegistration[], timeoutSeconds: number): Record<string, unknown> {
  const byEvent: Record<string, unknown[]> = {};
  for (const h of hooks) {
    const entry: Record<string, unknown> = {
      hooks: [{ type: "command", command: h.command, timeout: timeoutSeconds }],
    };
    if (TOOL_EVENTS.includes(h.event)) entry.matcher = "*";
    (byEvent[h.event] ??= []).push(entry);
  }
  return { hooks: byEvent };
}
