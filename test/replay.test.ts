import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replay } from "../src/replay.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/consumer/hookcompat.yml", import.meta.url));

const DENY = { type: "command", command: "echo blocked >&2; exit 2" };

function project(config: string, matcher = "Task", hook: object = DENY) {
  const dir = mkdtempSync(join(tmpdir(), "hookcompat-replay-"));
  writeFileSync(join(dir, "hookcompat.yml"), config);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [hook] }] } }));
  return join(dir, "hookcompat.yml");
}

const CASE = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: pretooluse-subagent\n    expect: deny\n";

describe("replay", () => {
  it("catches a hook that checks tool_name for Task, which is Agent in Claude Code 2.1.63", async () => {
    const report = await replay(EXAMPLE, DATA);
    expect(report.ok).toBe(false);
    expect(report.results.map((r) => [r.version, r.toolName, r.status, r.got?.kind])).toEqual([
      ["2.1.62", "Task", "pass", "deny"],
      ["2.1.63", "Agent", "fail", "no-opinion"],
    ]);
  });

  it("passes the fixed example on both versions", async () => {
    const report = await replay(EXAMPLE.replace("hookcompat.yml", "hookcompat.fixed.yml"), DATA);
    expect(report).toMatchObject({ ok: true, executed: 2, passed: 2 });
  });

  it("passes a hook selected by a Task matcher on both versions", async () => {
    expect(await replay(project(CASE, "Task"), DATA)).toMatchObject({ ok: true, executed: 2, passed: 2 });
  });

  it("points the payload cwd at the project directory", async () => {
    const hook = { type: "command", command: 'test "$(jq -r .cwd)" = "$CLAUDE_PROJECT_DIR" && exit 2; exit 0' };
    expect(await replay(project(CASE, "*", hook), DATA)).toMatchObject({ ok: true, passed: 2 });
  });

  it("fails when nothing matches the filter", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: no-such-scenario\n    expect: deny\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, executed: 0, error: "no matching fixtures" });
  });

  it("fails when every case is unsupported", async () => {
    const report = await replay(project(CASE, "*", { type: "prompt", prompt: "deny subagents" }), DATA);
    expect(report).toMatchObject({ ok: false, executed: 0, unsupported: 2 });
  });

  it("skips unreviewed fixtures, and fails if none are left", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: pretooluse-subagent\n    event: Stop\n    expect: no-opinion\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, unreviewed: 2, error: "no reviewed fixtures (2 unreviewed skipped)" });
  });
});
