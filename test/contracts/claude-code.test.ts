// Expected results are written by hand from the Claude Code hooks docs
// (code.claude.com/docs/en/hooks, checked 2026-09-30) and live captures. They are not produced by our code.
import { describe, expect, it } from "vitest";
import { combine, decode, matches } from "../../src/contracts/claude-code.js";

const run = (exitCode: number, stdout = "", stderr = "") => ({ exitCode, timedOut: false, stdout, stderr });
const specific = (permissionDecision: unknown) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision } });

describe("Claude Code PreToolUse decode", () => {
  it("exit 2 blocks, and JSON on stdout is ignored", () => {
    // Docs: "Exit code 2 ... blocks the tool call"; JSON is only processed on exit 0.
    expect(decode(run(2, specific("allow"), "no")).kind).toBe("deny");
  });

  it("exit 0 uses hookSpecificOutput.permissionDecision, keeping defer distinct", () => {
    // Docs: permissionDecision is "allow", "deny", "ask" or "defer".
    for (const d of ["allow", "deny", "ask", "defer"]) expect(decode(run(0, specific(d))).kind).toBe(d);
  });

  it("maps legacy approve and block, with a deprecation warning", () => {
    // Docs: top-level decision is deprecated for PreToolUse; "approve" and "block" map to allow and deny.
    const approve = decode(run(0, JSON.stringify({ decision: "approve" })));
    expect(approve.kind).toBe("allow");
    expect(approve.warnings).toHaveLength(1);
    expect(decode(run(0, JSON.stringify({ decision: "block" }))).kind).toBe("deny");
  });

  it("rejects an invalid top-level decision even with a valid nested one", () => {
    // agent-harness-kit #17: top-level "deny" is not a documented value.
    const out = JSON.stringify({ decision: "deny", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(decode(run(0, out)).kind).toBe("error");
  });

  it("treats exit 0 without JSON as no opinion, and other exit codes as errors", () => {
    // Docs: other non-zero exit codes are non-blocking errors.
    expect(decode(run(0)).kind).toBe("no-opinion");
    expect(decode(run(1)).kind).toBe("error");
  });

  it("reports that no hook matched", () => {
    expect(combine([])).toMatchObject({ kind: "no-opinion", detail: "no hook matched" });
  });
});

describe("Claude Code matchers", () => {
  it("match tool names exactly or by alternation", () => {
    // Docs: matcher is a tool name or a regex like "Edit|Write"; "*" matches all tools.
    expect(matches("Bash", "Edit")).toBe(false);
    expect(matches("Edit|Write", "Write")).toBe(true);
    expect(matches("*", "Agent")).toBe(true);
  });

  it("still match the renamed subagent tool by its old name", () => {
    // anthropics/claude-code#29677: "Task" in settings still matches the Agent tool.
    expect(matches("Task", "Agent")).toBe(true);
  });
});
