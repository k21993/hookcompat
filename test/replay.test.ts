import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replay } from "../src/replay.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/consumer/hookcompat.yml", import.meta.url));

function project(config: string, matcher = "Task") {
  const dir = mkdtempSync(join(tmpdir(), "hookcompat-replay-"));
  writeFileSync(join(dir, "hookcompat.yml"), config);
  const hook = { type: "command", command: "echo blocked >&2; exit 2" };
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [hook] }] } }));
  return join(dir, "hookcompat.yml");
}

describe("replay", () => {
  it("catches the Task to Agent rename in Claude Code 2.1.63", async () => {
    const report = await replay(EXAMPLE, DATA);
    expect(report.ok).toBe(false);
    expect(report.results.map((r) => [r.version, r.toolName, r.status, r.got?.kind])).toEqual([
      ["2.1.62", "Task", "pass", "deny"],
      ["2.1.63", "Agent", "fail", "no-opinion"],
    ]);
  });

  it("passes a hook that matches both names", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: pretooluse-subagent\n    expect: deny\n";
    const report = await replay(project(config, "Task|Agent"), DATA);
    expect(report).toMatchObject({ ok: true, executed: 2, passed: 2 });
  });

  it("fails when nothing matches the filter", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: no-such-scenario\n    expect: deny\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, executed: 0, error: "no matching fixtures" });
  });

  it("fails when every case is unsupported", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: pretooluse-subagent\n    event: Stop\n    expect: deny\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, executed: 0, unsupported: 2 });
  });
});
