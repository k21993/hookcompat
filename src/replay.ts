import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { combine, decode, hooksFor, type Decision, type DecisionKind } from "./contracts/claude-code.js";
import { runBounded } from "./proc.js";
import { CaptureFixture } from "./schema.js";

const Kind = z.enum(["allow", "deny", "ask", "defer", "no-opinion", "error"]);

/** hookcompat.yml in the adopter's repo. Paths are relative to this file. */
export const ReplayConfig = z
  .object({
    harness: z.string(),
    /** A settings file with a `hooks` key, such as .claude/settings.json. */
    settings: z.string().optional(),
    /** A plugin directory. Its hooks/hooks.json is used, and CLAUDE_PLUGIN_ROOT points at it. */
    plugin: z.string().optional(),
    cases: z
      .array(
        z.object({
          scenario: z.string(),
          /** The first capture of this event in the scenario is replayed. */
          event: z.string().default("PreToolUse"),
          /** One decision, or a list when several are acceptable. */
          expect: z.union([Kind, z.array(Kind).min(1)]),
          /** Default: every version we have fixtures for. */
          versions: z.array(z.string()).min(1).optional(),
        }),
      )
      .min(1),
  })
  .refine((c) => (c.settings === undefined) !== (c.plugin === undefined), "set exactly one of settings or plugin");
export type ReplayConfig = z.infer<typeof ReplayConfig>;

export interface CaseResult {
  scenario: string;
  version: string;
  fixture: string;
  sha256: string;
  status: "pass" | "fail" | "unsupported";
  expected: DecisionKind[];
  /** Absent when the case was not executed. */
  got?: Decision;
  toolName?: string;
  detail?: string;
}

export interface ReplayReport {
  harness: string;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  unsupported: number;
  /** Matching fixtures skipped because nobody has reviewed them. */
  unreviewed: number;
  ok: boolean;
  /** Set when the run fails without a failing case. */
  error?: string;
  results: CaseResult[];
}

const SUPPORTED_HARNESSES = ["claude-code"];
const SUPPORTED_EVENTS = ["PreToolUse"];

export async function replay(configPath: string, dataDir: string): Promise<ReplayReport> {
  const config = ReplayConfig.parse(parseYaml(readFileSync(configPath, "utf8")));
  const projectDir = dirname(resolve(configPath));
  const pluginRoot = config.plugin === undefined ? undefined : resolve(projectDir, config.plugin);
  const settingsPath = pluginRoot ? join(pluginRoot, "hooks", "hooks.json") : join(projectDir, config.settings!);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_PROJECT_DIR: projectDir,
    ...(pluginRoot && { CLAUDE_PLUGIN_ROOT: pluginRoot }),
  };
  const results: CaseResult[] = [];
  const coverageErrors: string[] = [];
  let unreviewed = 0;

  for (const c of config.cases) {
    const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
    const fixtures = findFixtures(dataDir, config.harness, c.scenario, c.event, c.versions);
    const reviewedVersions = new Set<string>();
    for (const { version, path } of fixtures) {
      const raw = readFileSync(path, "utf8");
      const fixture = CaptureFixture.parse(JSON.parse(raw));
      // Only captures a person has checked count as evidence.
      if (fixture.review.status !== "reviewed") {
        unreviewed++;
        continue;
      }
      reviewedVersions.add(version);
      const base = {
        scenario: c.scenario,
        version,
        fixture: relative(dataDir, path),
        sha256: createHash("sha256").update(raw).digest("hex"),
        expected,
      };
      if (!SUPPORTED_HARNESSES.includes(config.harness) || !SUPPORTED_EVENTS.includes(c.event)) {
        results.push({ ...base, status: "unsupported", detail: `${config.harness} ${c.event} is not supported yet` });
        continue;
      }
      const payload = withRepoDir(fixture.payload, projectDir) as { tool_name?: string };
      const toolName = payload?.tool_name ?? "";
      const { hooks, unsupported } = hooksFor(settings, toolName);
      if (unsupported.length > 0) {
        results.push({ ...base, status: "unsupported", toolName, detail: `matching ${unsupported.join(", ")} not supported` });
        continue;
      }
      const decisions: Decision[] = [];
      for (const hook of hooks) {
        const run = await runBounded({
          argv: ["sh", "-c", hook.command],
          cwd: projectDir,
          env,
          input: JSON.stringify(payload),
          timeoutMs: (hook.timeout ?? 60) * 1000,
          maxOutputBytes: 1024 * 1024,
        });
        decisions.push(decode(run));
      }
      const got = combine(decisions);
      results.push({ ...base, status: expected.includes(got.kind) ? "pass" : "fail", got, toolName });
    }
    if (c.versions) {
      for (const version of new Set(c.versions)) {
        if (!reviewedVersions.has(version)) coverageErrors.push(`${c.scenario} (${c.event}, ${version}): no reviewed fixture`);
      }
    } else if (reviewedVersions.size === 0) {
      coverageErrors.push(`${c.scenario} (${c.event}): ${fixtures.length ? "no reviewed fixtures" : "no matching fixtures"}`);
    }
  }

  const count = (s: CaseResult["status"]) => results.filter((r) => r.status === s).length;
  const executed = results.filter((r) => r.got).length;
  const report: ReplayReport = {
    harness: config.harness,
    selected: results.length,
    executed,
    passed: count("pass"),
    failed: count("fail"),
    unsupported: count("unsupported"),
    unreviewed,
    ok: false,
    results,
  };
  // Zero executed cases is never green.
  if (results.length === 0) report.error = unreviewed ? `no reviewed fixtures (${unreviewed} unreviewed skipped)` : "no matching fixtures";
  else if (coverageErrors.length > 0) report.error = coverageErrors.join("; ");
  else if (executed === 0) report.error = "no case was executed";
  else if (report.unsupported > 0) report.error = `${report.unsupported} selected cases are unsupported`;
  report.ok = !report.error && report.failed === 0 && report.unsupported === 0;
  return report;
}

/** The recorder redacts the sandbox repo to this path; it stands for the adopter's checkout. */
const REPO_PLACEHOLDER = "/hookcompat/repo";

/** Point redacted repo paths (cwd and paths under it) at the adopter's checkout, so hooks can find their files. */
export function withRepoDir(value: unknown, dir: string): unknown {
  if (typeof value === "string") {
    return value === REPO_PLACEHOLDER || value.startsWith(REPO_PLACEHOLDER + "/") ? dir + value.slice(REPO_PLACEHOLDER.length) : value;
  }
  if (Array.isArray(value)) return value.map((v) => withRepoDir(v, dir));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRepoDir(v, dir)]));
  }
  return value;
}

function findFixtures(dataDir: string, harness: string, scenario: string, event: string, versions?: string[]) {
  const harnessDir = join(dataDir, "fixtures", harness);
  if (!existsSync(harnessDir)) return [];
  const found: { version: string; path: string }[] = [];
  for (const version of readdirSync(harnessDir).sort(compareVersions)) {
    if (versions && !versions.includes(version)) continue;
    const dir = join(harnessDir, version, scenario);
    if (!existsSync(dir)) continue;
    // File names start with the capture order (NN-<Event>-<id>.json).
    const file = readdirSync(dir)
      .sort()
      .find((f) => f.split("-")[1] === event);
    if (file) found.push({ version, path: join(dir, file) });
  }
  return found;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Markdown for the GitHub job summary. Reports only what was observed. */
export function summary(report: ReplayReport): string {
  const lines = [
    `## hookcompat: ${report.ok ? "passed" : "failed"}`,
    "",
    `${report.harness}: ${report.selected} selected, ${report.executed} executed, ${report.passed} passed, ${report.failed} failed, ${report.unsupported} unsupported, ${report.unreviewed} unreviewed skipped`,
  ];
  if (report.error) lines.push("", `**${report.error}**`);
  if (report.results.length > 0) {
    lines.push("", "| Result | Scenario | Version | tool_name | Expected | Got | Fixture |", "|---|---|---|---|---|---|---|");
    for (const r of report.results) {
      const got = r.got ? `${r.got.kind}${r.got.detail ? ` (${r.got.detail})` : ""}` : (r.detail ?? "");
      lines.push(
        `| ${r.status.toUpperCase()} | ${r.scenario} | ${r.version} | ${r.toolName ?? ""} | ${r.expected.join(" or ")} | ${got} | \`${r.fixture}\` sha256:${r.sha256.slice(0, 12)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
