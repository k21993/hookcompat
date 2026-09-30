import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallError, installFromNpm } from "../src/recorder/adapters/common.js";
import { createSandbox } from "../src/recorder/sandbox.js";

const saved = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
});

describe("installFromNpm", () => {
  it("hides secrets from npm and reports a failed install", async () => {
    // A fake npm that records its environment, then fails.
    const bin = mkdtempSync(join(tmpdir(), "hookcompat-npm-"));
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nenv > "$HOME/npm-env.txt"\necho registry down >&2\nexit 1\n`);
    chmodSync(join(bin, "npm"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.OPENAI_API_KEY = "sk-test-install-secret";

    const sb = createSandbox();
    try {
      await expect(installFromNpm(sb, "@openai/codex", "0.0.0", "codex")).rejects.toThrow(InstallError);
      expect(readFileSync(join(sb.home, "npm-env.txt"), "utf8")).not.toContain("sk-test-install-secret");
    } finally {
      sb.cleanup();
    }
  });
});
