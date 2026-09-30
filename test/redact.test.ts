import { describe, expect, it } from "vitest";
import { createRedactor, RedactionError } from "../src/redact.js";

const redactor = createRedactor(
  [
    { from: "/tmp/hookcompat-abc/repo", to: "/hookcompat/repo" },
    { from: "/tmp/hookcompat-abc", to: "/hookcompat/sandbox" },
  ],
  ["super-secret-api-key-value"],
  "salt",
);

describe("redaction", () => {
  it("replaces sandbox paths, longest match first", () => {
    const { value, redactions } = redactor.redact({
      cwd: "/tmp/hookcompat-abc/repo",
      transcript_path: "/tmp/hookcompat-abc/home/t.jsonl",
    });
    expect(value).toEqual({ cwd: "/hookcompat/repo", transcript_path: "/hookcompat/sandbox/home/t.jsonl" });
    expect(redactions.sort()).toEqual(["cwd", "transcript_path"]);
  });

  it("replaces IDs with fakes of the same shape, stable within a run", () => {
    const session = "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b";
    const { value } = redactor.redact({ session_id: session, tool_use_id: "toolu_01AbCdEf", nested: { session_id: session } });
    const v = value as { session_id: string; tool_use_id: string; nested: { session_id: string } };
    expect(v.session_id).not.toBe(session);
    expect(v.session_id).toMatch(/^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/);
    expect(v.nested.session_id).toBe(v.session_id);
    expect(v.tool_use_id).toMatch(/^toolu_[0-9][0-9][A-Z][a-z][A-Z][a-z][A-Z][a-z]$/);
  });

  it("leaves other values untouched", () => {
    expect(redactor.redact({ tool_input: { command: "echo hi" }, n: 3 }).value).toEqual({ tool_input: { command: "echo hi" }, n: 3 });
  });

  it("fails closed on configured secrets and known secret patterns", () => {
    expect(() => redactor.assertNoSecrets({ x: "super-secret-api-key-value" }, "f")).toThrow(RedactionError);
    expect(() => redactor.assertNoSecrets({ x: "sk-ant-api03-abcdefghijklmnop" }, "f")).toThrow(RedactionError);
    expect(() => redactor.assertNoSecrets({ x: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "f")).toThrow(RedactionError);
    expect(() => redactor.assertNoSecrets({ x: "nothing to see" }, "f")).not.toThrow();
  });
});
