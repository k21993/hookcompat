import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { record } from "../src/recorder/record.js";
import { CaptureFixture, Scenario } from "../src/schema.js";
import { fakeAdapter } from "./helpers/fake-adapter.js";

const scenario = (respond: "allow" | "deny") =>
  Scenario.parse({
    id: `fake-shell-write-${respond}`,
    intent: "test",
    prompt: "write {{marker}}",
    capture_events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    respond: { PreToolUse: respond },
  });

describe("recorder pipeline with a fake CLI", () => {
  it("records every event in order, redacted, with full context", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const res = await record({ adapter: fakeAdapter, scenario: scenario("allow"), outDir: out, timeoutMs: 30_000 });

    expect(res.status).toBe("ok");
    expect(res.cliVersion).toBe("0.0.1");
    expect(res.markerCreated).toBe(true);
    expect(res.eventsCaptured).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);

    const files = readdirSync(res.runDir!).sort();
    expect(files).toContain("recording.json");
    const pre = CaptureFixture.parse(
      JSON.parse(readFileSync(join(res.runDir!, files.find((f) => f.includes("-PreToolUse-"))!), "utf8")),
    );
    const payload = pre.payload as Record<string, unknown>;
    expect(payload.cwd).toBe("/hookcompat/repo");
    expect(payload.session_id).not.toBe("3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b");
    expect(payload.transcript_path).toBe(`/hookcompat/home/.claude/projects/-hookcompat-repo/${payload.session_id}.jsonl`);
    expect(pre.review.status).toBe("unreviewed");

    const recording = JSON.parse(readFileSync(join(res.runDir!, "recording.json"), "utf8"));
    expect(recording.context.config.content).toContain("/hookcompat/sandbox/bin/capture.mjs");
    expect(recording.context.config.content).not.toContain(tmpdir() + "/hookcompat-");
    expect(recording.context.model).toBe("fake-model-1");
    expect(recording.context.envAllowlist).toContain("HOOKCOMPAT_FAKE_KEY");
  });

  it("deny scenario: PreToolUse is captured, the hook answered deny, and the marker is absent", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const res = await record({ adapter: fakeAdapter, scenario: scenario("deny"), outDir: out, timeoutMs: 30_000 });
    expect(res.status).toBe("ok");
    expect(res.markerCreated).toBe(false);
    expect(res.eventsCaptured).not.toContain("PostToolUse");
    const recording = JSON.parse(readFileSync(join(res.runDir!, "recording.json"), "utf8"));
    expect(recording.evidence).toContainEqual(expect.objectContaining({ event: "PreToolUse", tool: "Bash", responded: "deny" }));
  });

  it("reports a CLI killed by a signal as failed, keeping its captures", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const killed = Scenario.parse({ ...scenario("allow"), id: "killed", prompt: "write {{marker}} fake:sigterm" });
    const res = await record({ adapter: fakeAdapter, scenario: killed, outDir: out, timeoutMs: 30_000 });
    expect(res.status).toBe("cli-failed");
    expect(res.eventsCaptured.length).toBeGreaterThan(0);
  });

  it("marks a run with truncated hook input as incomplete, and keeps the flag", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const huge = Scenario.parse({ ...scenario("allow"), id: "huge", prompt: "write {{marker}} fake:huge" });
    const res = await record({ adapter: fakeAdapter, scenario: huge, outDir: out, timeoutMs: 30_000 });
    expect(res.status).toBe("incomplete");
    const fixtures = readdirSync(res.runDir!)
      .filter((f) => f !== "recording.json")
      .map((f) => CaptureFixture.parse(JSON.parse(readFileSync(join(res.runDir!, f), "utf8"))));
    expect(fixtures.filter((f) => f.stdinTruncated)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(res.runDir!, "recording.json"), "utf8")).status).toBe("incomplete");
  });

  it("redacts paths when the temp dir is a symlink (as on macOS)", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "hookcompat-link-")), "tmp");
    symlinkSync(mkdtempSync(join(tmpdir(), "hookcompat-real-")), link);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = link;
    try {
      const out = mkdtempSync(join(saved ?? "/tmp", "hookcompat-out-"));
      const res = await record({ adapter: fakeAdapter, scenario: scenario("allow"), outDir: out, timeoutMs: 30_000 });
      const pre = readdirSync(res.runDir!).find((f) => f.includes("-PreToolUse-"))!;
      expect(JSON.parse(readFileSync(join(res.runDir!, pre), "utf8")).payload.cwd).toBe("/hookcompat/repo");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("writes scenario files into the sandbox repo before the run", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const seeded = Scenario.parse({ ...scenario("allow"), id: "seeded", files: { ".claude/agents/research.md": "x" } });
    const res = await record({ adapter: fakeAdapter, scenario: seeded, outDir: out, timeoutMs: 30_000 });
    const start = readdirSync(res.runDir!).find((f) => f.includes("-SessionStart-"))!;
    expect(JSON.parse(readFileSync(join(res.runDir!, start), "utf8")).payload.repo_files).toContain(join(".claude", "agents", "research.md"));
  });

  it("rejects scenario file paths that are not a file inside the repo", () => {
    for (const path of ["", ".", "../escape", "a/../../escape", "/etc/passwd"]) {
      expect(() => Scenario.parse({ ...scenario("allow"), files: { [path]: "x" } }), path).toThrow();
    }
  });

  it("redacts Claude Code's per-user temp directory", async () => {
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    const tmp = `/private/tmp/claude-${process.getuid!()}/-repo/tasks/a.output`;
    const s = Scenario.parse({ ...scenario("allow"), id: "claude-tmp", prompt: `write {{marker}} ${tmp}` });
    const res = await record({ adapter: fakeAdapter, scenario: s, outDir: out, timeoutMs: 30_000 });
    const prompt = readdirSync(res.runDir!).find((f) => f.includes("-UserPromptSubmit-"))!;
    expect(JSON.parse(readFileSync(join(res.runDir!, prompt), "utf8")).payload.prompt).toContain("/hookcompat/claude-tmp/-repo/tasks/a.output");
  });

  it("writes nothing when a secret would leak", async () => {
    process.env.HOOKCOMPAT_FAKE_KEY = "fake-user-home-secret-value";
    const out = mkdtempSync(join(tmpdir(), "hookcompat-out-"));
    try {
      const leaky = Scenario.parse({ ...scenario("allow"), id: "leaky", prompt: "write {{marker}} fake-user-home-secret-value" });
      const res = await record({ adapter: fakeAdapter, scenario: leaky, outDir: out, timeoutMs: 30_000 });
      expect(res.status).toBe("redaction-failed");
      expect(readdirSync(out)).toEqual([]);
    } finally {
      delete process.env.HOOKCOMPAT_FAKE_KEY;
    }
  });
});
