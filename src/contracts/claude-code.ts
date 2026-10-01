/**
 * How Claude Code reads hook settings and hook output, for PreToolUse only.
 * Rules come from code.claude.com/docs/en/hooks (checked 2026-09-30) unless marked "inferred".
 */

export type DecisionKind = "allow" | "deny" | "ask" | "defer" | "no-opinion" | "error";

export interface Decision {
  kind: DecisionKind;
  detail?: string;
  warnings: string[];
}

export interface HookRun {
  exitCode: number | null;
  timedOut: boolean;
  launchError?: string;
  stdout: string;
  stderr: string;
}

export interface CommandHook {
  command: string;
  /** Seconds. Docs: defaults to 60. */
  timeout?: number;
}

const PERMISSION_DECISIONS = new Set(["allow", "deny", "ask", "defer"]);
/** Deprecated top-level `decision` values that still work. */
const LEGACY = { approve: "allow", block: "deny" } as const;

/**
 * Exact matchers that still select a renamed tool.
 * anthropics/claude-code#29677: after the Task to Agent rename, matcher "Task" still matches the Agent tool.
 * Only the exact old name is covered; whether regexes like "T.*" also match is unverified.
 */
const EXACT_ALIASES: Record<string, string> = { Task: "Agent" };

/**
 * Docs: "*", "" or a missing matcher matches every tool; otherwise the matcher is a tool name
 * or a regex such as "Edit|Write". Inferred: the regex must match the whole tool name.
 */
export function matches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (EXACT_ALIASES[matcher] === toolName) return true;
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}

/** The command hooks Claude Code would run for this PreToolUse call, from a settings.json object. */
export function hooksFor(settings: unknown, toolName: string): { hooks: CommandHook[]; unsupported: string[] } {
  const entries = (settings as { hooks?: { PreToolUse?: unknown[] } })?.hooks?.PreToolUse ?? [];
  const hooks: CommandHook[] = [];
  const unsupported: string[] = [];
  for (const entry of entries as { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]) {
    if (!matches(entry.matcher, toolName)) continue;
    for (const h of entry.hooks ?? []) {
      if (h.type === "command" && typeof h.command === "string") hooks.push({ command: h.command, timeout: h.timeout });
      else unsupported.push(`hook type "${h.type}"`);
    }
  }
  return { hooks, unsupported };
}

/** Decode one PreToolUse hook run. */
export function decode(run: HookRun): Decision {
  const warnings: string[] = [];
  if (run.launchError) return { kind: "error", detail: `could not start: ${run.launchError}`, warnings };
  if (run.timedOut) return { kind: "error", detail: "timed out", warnings };
  // Docs: exit code 2 blocks the tool call; stderr is the reason. JSON on stdout is ignored.
  if (run.exitCode === 2) return { kind: "deny", detail: run.stderr.trim() || undefined, warnings };
  // Docs: any other non-zero exit is a non-blocking error.
  if (run.exitCode !== 0) return { kind: "error", detail: `exit code ${run.exitCode}`, warnings };

  const text = run.stdout.trim();
  if (!text.startsWith("{")) return { kind: "no-opinion", warnings };
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(text);
  } catch {
    return { kind: "error", detail: "stdout looks like JSON but does not parse", warnings };
  }

  // Docs: top-level `decision` is deprecated for PreToolUse; "approve" and "block" still map to allow and deny.
  let legacy: DecisionKind | undefined;
  if (out.decision !== undefined) {
    const mapped = LEGACY[out.decision as keyof typeof LEGACY];
    if (!mapped) return { kind: "error", detail: `invalid top-level decision ${JSON.stringify(out.decision)}`, warnings };
    warnings.push(`top-level decision "${out.decision}" is deprecated; use hookSpecificOutput.permissionDecision`);
    legacy = mapped;
  }

  const specific = out.hookSpecificOutput as Record<string, unknown> | undefined;
  if (specific && specific.permissionDecision !== undefined) {
    if (specific.hookEventName !== "PreToolUse") {
      warnings.push(`hookEventName is ${JSON.stringify(specific.hookEventName)}, expected "PreToolUse"`);
    }
    const d = specific.permissionDecision;
    if (typeof d !== "string" || !PERMISSION_DECISIONS.has(d)) {
      return { kind: "error", detail: `invalid permissionDecision ${JSON.stringify(d)}`, warnings };
    }
    const reason = specific.permissionDecisionReason;
    return { kind: d as DecisionKind, detail: typeof reason === "string" ? reason : undefined, warnings };
  }
  return { kind: legacy ?? "no-opinion", warnings };
}

/** Inferred: when several hooks match, the most restrictive result wins. */
const PRECEDENCE: DecisionKind[] = ["deny", "error", "defer", "ask", "allow", "no-opinion"];

export function combine(decisions: Decision[]): Decision {
  if (decisions.length === 0) return { kind: "no-opinion", detail: "no hook matched", warnings: [] };
  const kind = PRECEDENCE.find((k) => decisions.some((d) => d.kind === k))!;
  const winner = decisions.find((d) => d.kind === kind)!;
  return { kind, detail: winner.detail, warnings: decisions.flatMap((d) => d.warnings) };
}
