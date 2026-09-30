import type { HarnessId, HookEvent } from "../../schema.js";
import type { BoundedRunResult } from "../../proc.js";
import type { Sandbox } from "../sandbox.js";

export interface HookRegistration {
  event: HookEvent;
  /** Full shell command the CLI should run for this event. */
  command: string;
}

export interface WrittenConfig {
  path: string;
  content: string;
}

export interface RunOptions {
  prompt: string;
  model?: string;
  timeoutMs: number;
  /** Extra CLI arguments, for adjusting flags without code changes while contracts are being verified. */
  extraArgs: string[];
}

export interface AdapterRun {
  argv: string[];
  result: BoundedRunResult;
}

export interface HarnessAdapter {
  id: HarnessId;
  /** Environment variables (credentials) passed through to the CLI. Nothing else from the parent env is. */
  credentialEnv: string[];
  /**
   * Returns the command prefix used to launch the CLI.
   * With a version, installs exactly that version into the sandbox; without one, uses the CLI on PATH.
   */
  resolve(sb: Sandbox, version: string | undefined): Promise<string[]>;
  version(cli: string[], sb: Sandbox, env: NodeJS.ProcessEnv): Promise<string>;
  writeHookConfig(sb: Sandbox, hooks: HookRegistration[]): WrittenConfig;
  run(cli: string[], sb: Sandbox, env: NodeJS.ProcessEnv, config: WrittenConfig, opts: RunOptions): Promise<AdapterRun>;
}
