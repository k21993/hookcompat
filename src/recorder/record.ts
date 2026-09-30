import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRedactor, RedactionError } from "../redact.js";
import { CaptureContext, CaptureFixture, EvidenceLine, type Scenario } from "../schema.js";
import { createSandbox, sandboxEnv } from "./sandbox.js";
import { InstallError } from "./adapters/common.js";
import type { HarnessAdapter, HookRegistration } from "./adapters/types.js";

/** Anything other than "ok" means the captures must not be used as compatibility evidence. */
export type RecordStatus =
  | "ok"
  | "install-failed"
  | "no-captures"
  | "incomplete"
  | "cli-failed"
  | "timeout"
  | "redaction-failed";

export interface RecordOptions {
  adapter: HarnessAdapter;
  scenario: Scenario;
  /** Install this exact CLI version; otherwise use the CLI on PATH. */
  cliVersion?: string;
  model?: string;
  outDir: string;
  timeoutMs: number;
  extraArgs?: string[];
  keepSandbox?: boolean;
}

export interface RecordResult {
  status: RecordStatus;
  runId: string;
  cliVersion: string;
  runDir?: string;
  eventsCaptured: string[];
  markerCreated: boolean;
  message?: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { adapter, scenario } = opts;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const sb = createSandbox();
  try {
    const { env, allowlist } = sandboxEnv(sb, adapter.credentialEnv);

    const respondPath = join(sb.root, "respond.json");
    writeFileSync(respondPath, JSON.stringify(scenario.respond));
    const command = `node ${shellQuote(sb.captureHook)} ${shellQuote(sb.captureDir)} ${shellQuote(respondPath)}`;
    const hooks: HookRegistration[] = scenario.capture_events.map((event) => ({ event, command }));
    const config = adapter.writeHookConfig(sb, hooks);

    let cli: string[];
    try {
      cli = await adapter.resolve(sb, opts.cliVersion);
    } catch (err) {
      if (!(err instanceof InstallError)) throw err;
      const cliVersion = opts.cliVersion ?? "unknown";
      return { status: "install-failed", runId, cliVersion, eventsCaptured: [], markerCreated: false, message: err.message };
    }
    const cliVersion = await adapter.version(cli, sb, env);
    const prompt = scenario.prompt.replaceAll("{{marker}}", sb.marker);

    const { argv, result } = await adapter.run(cli, sb, env, config, {
      prompt,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      extraArgs: opts.extraArgs ?? [],
    });

    const markerCreated = existsSync(join(sb.repo, sb.marker));
    const secrets = adapter.credentialEnv.map((name) => process.env[name]).filter((v): v is string => !!v);
    const redactor = createRedactor(
      [
        { from: sb.repo, to: "/hookcompat/repo" },
        { from: sb.home, to: "/hookcompat/home" },
        { from: sb.root, to: "/hookcompat/sandbox" },
        { from: homedir(), to: "/hookcompat/user-home" },
      ],
      secrets,
      runId,
    );

    // Collect captures in arrival order. File names start with an ISO timestamp, so sorting by name orders them.
    const captureFiles = readdirSync(sb.captureDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    const fixtures: { name: string; fixture: CaptureFixture }[] = [];
    captureFiles.forEach((file, index) => {
      const raw = JSON.parse(readFileSync(join(sb.captureDir, file), "utf8")) as {
        invocationId: string;
        receivedAt: string;
        event: string;
        payload?: unknown;
        rawStdin?: string;
        stdinTruncated?: boolean;
      };
      const { value: payload, redactions } = redactor.redact(raw.payload);
      const fixture = CaptureFixture.parse({
        fixtureFormat: 1,
        kind: "capture",
        invocationId: raw.invocationId,
        harness: adapter.id,
        cliVersion,
        scenario: scenario.id,
        event: raw.event,
        receivedAt: raw.receivedAt,
        runId,
        payload,
        ...(raw.rawStdin !== undefined ? { rawStdin: redactor.redactText(raw.rawStdin) } : {}),
        stdinTruncated: raw.stdinTruncated === true,
        redactions,
        review: { status: "unreviewed" },
      });
      const shortId = raw.invocationId.slice(-8);
      fixtures.push({ name: `${String(index + 1).padStart(2, "0")}-${raw.event}-${shortId}.json`, fixture });
    });

    const evidencePath = join(sb.captureDir, "evidence.jsonl");
    const evidence = existsSync(evidencePath)
      ? readFileSync(evidencePath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => EvidenceLine.parse(JSON.parse(line)))
      : [];

    const redactedArgv = argv.map((a) => redactor.redactText(a));
    const redactedConfig = redactor.redactText(config.content);
    const context = CaptureContext.parse({
      runId,
      capturedAt: new Date().toISOString(),
      harness: adapter.id,
      cliVersion,
      model: modelFromCaptures(fixtures.map((f) => f.fixture.payload)) ?? opts.model ?? "unknown",
      argv: redactedArgv,
      os: `${process.platform}-${process.arch}`,
      node: process.version,
      config: {
        path: redactor.redactText(config.path),
        content: redactedConfig,
        sha256: createHash("sha256").update(redactedConfig).digest("hex"),
      },
      envAllowlist: allowlist,
    });

    let status: RecordStatus = "ok";
    if (result.timedOut) status = "timeout";
    else if (result.launchError || result.signal !== null || result.exitCode !== 0) status = "cli-failed";
    else if (fixtures.some((f) => f.fixture.stdinTruncated)) status = "incomplete";
    else if (fixtures.length === 0) status = "no-captures";

    const recording = {
      status,
      context,
      scenario,
      marker: sb.marker,
      markerCreated,
      evidence: evidence.map((e) => redactor.redact(e).value),
      run: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        launchError: result.launchError,
        stdoutTail: redactor.redactText(result.stdout.slice(-8000)),
        stderrTail: redactor.redactText(result.stderr.slice(-8000)),
      },
    };

    // Fail closed: nothing is written if any output still looks like it contains a secret.
    try {
      for (const { name, fixture } of fixtures) redactor.assertNoSecrets(fixture, name);
      redactor.assertNoSecrets(recording, "recording.json");
    } catch (err) {
      if (err instanceof RedactionError) {
        return { status: "redaction-failed", runId, cliVersion, eventsCaptured: [], markerCreated, message: err.message };
      }
      throw err;
    }

    const runDir = join(opts.outDir, adapter.id, cliVersion, scenario.id, runId);
    mkdirSync(runDir, { recursive: true });
    for (const { name, fixture } of fixtures) writeFileSync(join(runDir, name), JSON.stringify(fixture, null, 2) + "\n");
    writeFileSync(join(runDir, "recording.json"), JSON.stringify(recording, null, 2) + "\n");

    const eventsCaptured = fixtures.map((f) => f.fixture.event);

    return { status, runId, cliVersion, runDir, eventsCaptured, markerCreated };
  } finally {
    if (!opts.keepSandbox) sb.cleanup();
  }
}

function modelFromCaptures(payloads: unknown[]): string | undefined {
  for (const p of payloads) {
    if (p && typeof p === "object" && "model" in p && typeof (p as { model: unknown }).model === "string") {
      return (p as { model: string }).model;
    }
  }
  return undefined;
}
