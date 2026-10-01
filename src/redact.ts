import { createHash } from "node:crypto";

export class RedactionError extends Error {}

export interface PathReplacement {
  from: string;
  to: string;
}

/** Fields whose values identify a session or call. They are replaced with fake values of the same shape. */
const ID_FIELDS = new Set(["session_id", "turn_id", "tool_use_id", "prompt_id", "call_id"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_PATTERNS: [string, RegExp][] = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export interface Redactor {
  /** Returns a redacted deep copy plus the JSON paths that were changed. */
  redact(value: unknown): { value: unknown; redactions: string[] };
  redactText(text: string): string;
  /** Throws RedactionError if anything that looks like a secret remains. */
  assertNoSecrets(value: unknown, label: string): void;
}

/**
 * @param paths   sandbox paths to replace with stable placeholders (longest match wins)
 * @param secrets exact secret values (API keys) that must never appear in output
 * @param salt    per-run salt so fake IDs are stable within a run but not across runs
 */
export function createRedactor(paths: PathReplacement[], secrets: string[], salt: string): Redactor {
  const ordered = [...paths].filter((p) => p.from.length > 0).sort((a, b) => b.from.length - a.from.length);
  const knownSecrets = secrets.filter((s) => s.length >= 8);
  const idMap = new Map<string, string>();

  const redactText = (text: string): string => {
    let result = text;
    for (const { from, to } of ordered) result = result.split(from).join(to);
    // IDs also appear inside other strings, e.g. a transcript file named after the session ID.
    for (const [original, fake] of idMap) result = result.split(original).join(fake);
    return result;
  };

  const fakeId = (original: string): string => {
    const cached = idMap.get(original);
    if (cached) return cached;
    const digest = createHash("sha256").update(salt).update(original).digest();
    let i = 0;
    const next = () => digest[i++ % digest.length]!;
    // Keep a leading alphabetic prefix such as "toolu_" or "call_" so the shape stays realistic.
    const prefix = /^[A-Za-z]+_/.exec(original)?.[0] ?? "";
    const rest = original.slice(prefix.length);
    // Hex IDs (including UUIDs) stay hex, so validators still accept them.
    // Mixed-case hex is only treated as hex for UUIDs; otherwise it is likely base62 (e.g. "toolu_01AbCdEf").
    const hex = UUID.test(rest) || /^(?:[0-9a-f-]+|[0-9A-F-]+)$/.test(rest);
    const hexDigits = "0123456789abcdef";
    let body = rest.replace(/[0-9a-zA-Z]/g, (ch) => {
      const n = next();
      if (hex) {
        const digit = hexDigits[n % 16]!;
        return /[A-F]/.test(ch) ? digit.toUpperCase() : digit;
      }
      if (/[0-9]/.test(ch)) return String(n % 10);
      if (/[a-z]/.test(ch)) return String.fromCharCode(97 + (n % 26));
      return String.fromCharCode(65 + (n % 26));
    });
    if (UUID.test(rest)) {
      // Keep the original version and variant digits so the fake is the same kind of UUID.
      body = body.slice(0, 14) + rest[14] + body.slice(15, 19) + rest[19] + body.slice(20);
    }
    const fake = prefix + body;
    idMap.set(original, fake);
    return fake;
  };

  const walk = (value: unknown, path: string, changed: string[]): unknown => {
    if (typeof value === "string") {
      const key = path.split(".").pop() ?? "";
      const next = ID_FIELDS.has(key) ? fakeId(value) : redactText(value);
      if (next !== value) changed.push(path);
      return next;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, changed));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, path ? `${path}.${k}` : k, changed);
      return out;
    }
    return value;
  };

  const collectIds = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (ID_FIELDS.has(key)) fakeId(value);
    } else if (Array.isArray(value)) value.forEach((v) => collectIds(v, key));
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) collectIds(v, k);
    }
  };

  return {
    redact(value) {
      collectIds(value, "");
      const redactions: string[] = [];
      const redacted = walk(value, "", redactions);
      return { value: redacted, redactions };
    },
    redactText,
    assertNoSecrets(value, label) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const secret of knownSecrets) {
        if (text.includes(secret)) throw new RedactionError(`${label}: contains a configured secret value`);
      }
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) throw new RedactionError(`${label}: matches secret pattern "${name}"`);
      }
    },
  };
}
