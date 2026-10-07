import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replay, summary, withRepoDir } from "../src/replay.js";

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

  it("runs plugin hooks with CLAUDE_PLUGIN_ROOT set to the plugin directory", async () => {
    const config = project(CASE.replace("settings: settings.json", "plugin: plugins/guard"));
    const plugin = join(config, "..", "plugins", "guard");
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "guard.sh"), "exit 2");
    const hook = { type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/guard.sh"' };
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [hook] }] } }));
    expect(await replay(config, DATA)).toMatchObject({ ok: true, passed: 2 });
  });

  it("maps paths under the repo placeholder and leaves look-alike prefixes alone", () => {
    expect(withRepoDir({ a: ["/hookcompat/repo/foo"], b: "/hookcompat/repository/foo" }, "/work")).toEqual({
      a: ["/work/foo"],
      b: "/hookcompat/repository/foo",
    });
  });

  it("fails when nothing matches the filter", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: no-such-scenario\n    expect: deny\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, executed: 0, error: "no matching fixtures" });
  });

  it("fails when every case is unsupported", async () => {
    const report = await replay(project(CASE, "*", { type: "prompt", prompt: "deny subagents" }), DATA);
    expect(report).toMatchObject({ ok: false, executed: 0, unsupported: 2 });
  });

  it.each(["async", "asyncRewake"])("does not execute a matching %s hook", async (flag) => {
    const hook = { ...DENY, command: "touch executed; exit 2", [flag]: true };
    const config = project(CASE, "*", hook);
    expect(await replay(config, DATA)).toMatchObject({ ok: false, executed: 0, passed: 0, unsupported: 2 });
    expect(existsSync(join(config, "..", "executed"))).toBe(false);
  });

  it("fails unsupported cases even when another case passes", async () => {
    const config = project(CASE + "  - scenario: pretooluse-shell-write\n    expect: no-opinion\n", "Task", { ...DENY, async: true });
    const report = await replay(config, DATA);
    expect(report).toMatchObject({ ok: false, passed: 3, unsupported: 2 });
    expect(summary(report)).toContain("UNSUPPORTED");
  });

  it.each(["SessionStart", undefined])("fails a deny with output event %s", async (hookEventName) => {
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: "deny" } });
    const report = await replay(project(CASE, "*", { type: "command", command: `echo '${output}'` }), DATA);
    expect(report).toMatchObject({ ok: false, failed: 2 });
    expect(report.results.every((r) => r.got?.kind === "error")).toBe(true);
    expect(summary(report)).toContain('expected "PreToolUse"');
  });

  it("fails a missing scenario even when the harmless case passes", async () => {
    const config = CASE.replace("pretooluse-subagent", "pretooluse-shell-git-reset-hadr") +
      "  - scenario: pretooluse-shell-write\n    expect: no-opinion\n";
    const report = await replay(project(config, "Task"), DATA);
    expect(report).toMatchObject({ ok: false, passed: 3 });
    expect(report.error).toContain("pretooluse-shell-git-reset-hadr");
  });

  it("fails a missing version even when another requested version passes", async () => {
    const report = await replay(project(CASE + "    versions: [2.1.62, 0.0.0]\n"), DATA);
    expect(report).toMatchObject({ ok: false, passed: 1 });
    expect(report.error).toContain("0.0.0");
    expect(report.error).toContain("pretooluse-subagent");
  });

  it("fails a case with only unreviewed fixtures even when another case passes", async () => {
    const config = CASE + "  - scenario: pretooluse-subagent\n    event: Stop\n    expect: no-opinion\n";
    const report = await replay(project(config), DATA);
    expect(report).toMatchObject({ ok: false, passed: 2, unreviewed: 2 });
    expect(report.error).toContain("Stop");
  });

  it("rejects an empty version filter instead of omitting the case", async () => {
    await expect(replay(project(CASE + "    versions: []\n"), DATA)).rejects.toThrow();
  });

  it.each([false, true])("requires every requested version to be reviewed when versions is explicit: %s", async (explicit) => {
    const data = mkdtempSync(join(tmpdir(), "hookcompat-fixtures-"));
    try {
      cpSync(join(DATA, "fixtures"), join(data, "fixtures"), { recursive: true });
      const scenario = join(data, "fixtures", "claude-code", "2.1.63", "pretooluse-subagent");
      const path = join(scenario, readdirSync(scenario).find((name) => name.includes("-PreToolUse-"))!);
      const fixture = JSON.parse(readFileSync(path, "utf8"));
      fixture.review = { status: "unreviewed" };
      writeFileSync(path, JSON.stringify(fixture));
      const config = project(CASE + (explicit ? "    versions: [2.1.62, 2.1.63]\n" : ""));
      const report = await replay(config, data);
      expect(report).toMatchObject({ ok: !explicit, passed: 1, unreviewed: 1 });
      if (explicit) expect(report.error).toContain("2.1.63");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("skips unreviewed fixtures, and fails if none are left", async () => {
    const config = "harness: claude-code\nsettings: settings.json\ncases:\n  - scenario: pretooluse-subagent\n    event: Stop\n    expect: no-opinion\n";
    expect(await replay(project(config), DATA)).toMatchObject({ ok: false, unreviewed: 2, error: "no reviewed fixtures (2 unreviewed skipped)" });
  });
});
