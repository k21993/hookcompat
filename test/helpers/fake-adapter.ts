import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "../../src/proc.js";
import { hooksObject, readVersion } from "../../src/recorder/adapters/common.js";
import type { HarnessAdapter } from "../../src/recorder/adapters/types.js";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));

/** Runs the recorder pipeline in PR CI. Does not reflect real CLI behavior. */
export const fakeAdapter: HarnessAdapter = {
  id: "fake",
  credentialEnv: ["HOOKCOMPAT_FAKE_KEY"],
  async resolve() {
    return [process.execPath, FAKE_CLI];
  },
  version: readVersion,
  writeHookConfig(sb, hooks) {
    const path = join(sb.root, "fake-hooks.json");
    const content = JSON.stringify(hooksObject(hooks, 30), null, 2);
    writeFileSync(path, content);
    return { path, content };
  },
  async run(cli, sb, env, config, opts) {
    const argv = [...cli, "--config", config.path, "--marker", sb.marker, "--prompt", opts.prompt];
    const result = await runBounded({ argv, cwd: sb.repo, env, timeoutMs: opts.timeoutMs, maxOutputBytes: 1024 * 1024 });
    return { argv, result };
  },
};
