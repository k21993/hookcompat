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
export const ReplayConfig = z.object({
  harness: z.string(),
  settings: z.string(),
  cases: z
    .array(
      z.object({
        scenario: z.string(),
        /** The first capture of this event in the scenario is replayed. */
        event: z.string().default("PreToolUse"),
        /** One decision, or a list when several are acceptable. */
        expect: z.union([Kind, z.array(Kind).min(1)]),
        /** Default: every version we have fixtures for. */
        versions: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});
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
  const settings = JSON.parse(readFileSync(join(projectDir, config.settings), "utf8"));
  const results: CaseResult[] = [];

  for (const c of config.cases) {
    const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
    for (const { version, path } of findFixtures(dataDir, config.harness, c.scenario, c.event, c.versions)) {
      const raw = readFileSync(path, "utf8");
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
      const payload = CaptureFixture.parse(JSON.parse(raw)).payload as { tool_name?: string };
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
          env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PROJECT_DIR: projectDir },
          input: JSON.stringify(payload),
          timeoutMs: (hook.timeout ?? 60) * 1000,
          maxOutputBytes: 1024 * 1024,
        });
        decisions.push(decode(run));
      }
      const got = combine(decisions);
      results.push({ ...base, status: expected.includes(got.kind) ? "pass" : "fail", got, toolName });
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
    ok: false,
    results,
  };
  // Zero executed cases is never green.
  if (results.length === 0) report.error = "no matching fixtures";
  else if (executed === 0) report.error = "no case was executed";
  report.ok = !report.error && report.failed === 0;
  return report;
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
    `${report.harness}: ${report.selected} selected, ${report.executed} executed, ${report.passed} passed, ${report.failed} failed, ${report.unsupported} unsupported`,
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
