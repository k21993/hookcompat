import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS } from "../src/redact.js";
import { CaptureFixture } from "../src/schema.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const files = readdirSync(DATA, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, text: readFileSync(join(DATA, f), "utf8") }));

/** Host paths that must never be committed. Redacted paths start with /hookcompat/. */
const HOST_PATHS = /(?<![\w-])\/(?:Users|home|private|var\/folders|tmp\/claude-)[^"]*/;

describe("committed fixtures", () => {
  it.each(files)("$name has no host paths or secrets", ({ text }) => {
    expect(text).not.toMatch(HOST_PATHS);
    for (const [, pattern] of SECRET_PATTERNS) expect(text).not.toMatch(pattern);
  });

  it.each(files.filter((f) => !f.name.endsWith("recording.json")))("$name is a valid capture", ({ text }) => {
    CaptureFixture.parse(JSON.parse(text));
  });

  it.each(files.filter((f) => f.name.endsWith("recording.json")))("$name keeps no raw CLI output", ({ text }) => {
    const run = JSON.parse(text).run;
    expect(run.stdoutTail).toBeUndefined();
    expect(run.stderrTail).toBeUndefined();
  });
});
