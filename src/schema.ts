import { z } from "zod";

export const HarnessId = z.enum(["claude-code", "codex", "fake"]);
export type HarnessId = z.infer<typeof HarnessId>;

export const HookEvent = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]);
export type HookEvent = z.infer<typeof HookEvent>;

/** What the capture hook answers for a given event while recording. */
export const Respond = z.enum(["allow", "deny", "ask", "none"]);
export type Respond = z.infer<typeof Respond>;

/** A harness-neutral recording script. `{{marker}}` is replaced with a fresh file name per run. */
export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  intent: z.string().min(1),
  prompt: z.string().includes("{{marker}}"),
  capture_events: z.array(HookEvent).min(1),
  respond: z.partialRecord(HookEvent, Respond).default({}),
});
export type Scenario = z.infer<typeof Scenario>;

/** Everything needed to understand, and re-run, how a capture was produced. */
export const CaptureContext = z.object({
  runId: z.string(),
  capturedAt: z.string(),
  harness: HarnessId,
  cliVersion: z.string(),
  model: z.string(),
  argv: z.array(z.string()),
  os: z.string(),
  node: z.string(),
  config: z.object({
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
  }),
  envAllowlist: z.array(z.string()),
});
export type CaptureContext = z.infer<typeof CaptureContext>;

/** One hook invocation, exactly as the CLI sent it (after redaction). Never edited after this. */
export const CaptureFixture = z.object({
  fixtureFormat: z.literal(1),
  kind: z.literal("capture"),
  invocationId: z.string(),
  harness: HarnessId,
  cliVersion: z.string(),
  scenario: z.string(),
  event: z.string(),
  receivedAt: z.string(),
  runId: z.string(),
  payload: z.unknown(),
  /** Set when stdin was not valid JSON; the redacted raw text. */
  rawStdin: z.string().optional(),
  redactions: z.array(z.string()),
  review: z.object({
    status: z.enum(["unreviewed", "reviewed"]),
    by: z.string().optional(),
    at: z.string().optional(),
    note: z.string().optional(),
  }),
});
export type CaptureFixture = z.infer<typeof CaptureFixture>;

/** One line of the capture hook's evidence log. */
export const EvidenceLine = z.object({
  invocationId: z.string(),
  receivedAt: z.string(),
  event: z.string(),
  tool: z.string().optional(),
  responded: Respond,
});
export type EvidenceLine = z.infer<typeof EvidenceLine>;
