import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBounded } from "../src/proc.js";

const HOOK = fileURLToPath(new URL("../hooks/capture.mjs", import.meta.url));

async function invoke(respond: Record<string, string>, stdin: string) {
  const dir = mkdtempSync(join(tmpdir(), "hookcompat-test-"));
  const respondPath = join(dir, "respond.json");
  writeFileSync(respondPath, JSON.stringify(respond));
  const res = await runBounded({
    argv: [process.execPath, HOOK, dir, respondPath],
    cwd: dir,
    env: { PATH: process.env.PATH },
    input: stdin,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  return { dir, res };
}

const pre = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

describe("capture hook", () => {
  it("writes the payload under a unique name and logs evidence", async () => {
    const { dir, res } = await invoke({}, pre);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    const files = readdirSync(dir).filter((f) => f.endsWith("-PreToolUse.json"));
    expect(files).toHaveLength(1);
    const captured = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(captured.payload.tool_input.command).toBe("ls");
    const evidence = readFileSync(join(dir, "evidence.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(evidence).toEqual([expect.objectContaining({ event: "PreToolUse", tool: "Bash", responded: "none" })]);
  });

  it("answers deny with hookSpecificOutput when the scenario asks for it", async () => {
    const { res } = await invoke({ PreToolUse: "deny" }, pre);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "hookcompat reference hook",
      },
    });
  });

  it("keeps non-JSON stdin as raw text instead of failing", async () => {
    const { dir, res } = await invoke({}, "not json");
    expect(res.exitCode).toBe(0);
    const file = readdirSync(dir).find((f) => f.endsWith("-unknown.json"))!;
    expect(JSON.parse(readFileSync(join(dir, file), "utf8")).rawStdin).toBe("not json");
  });

  it("gives concurrent invocations distinct files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hookcompat-test-"));
    const respondPath = join(dir, "respond.json");
    writeFileSync(respondPath, "{}");
    await Promise.all(
      Array.from({ length: 8 }, () =>
        runBounded({
          argv: [process.execPath, HOOK, dir, respondPath],
          cwd: dir,
          env: { PATH: process.env.PATH },
          input: pre,
          timeoutMs: 10_000,
          maxOutputBytes: 64 * 1024,
        }),
      ),
    );
    expect(readdirSync(dir).filter((f) => f.endsWith("-PreToolUse.json"))).toHaveLength(8);
    expect(readFileSync(join(dir, "evidence.jsonl"), "utf8").trim().split("\n")).toHaveLength(8);
  });
});
