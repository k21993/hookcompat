import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { Scenario } from "../schema.js";
import { claudeCode } from "./adapters/claude-code.js";
import { codex } from "./adapters/codex.js";
import type { HarnessAdapter } from "./adapters/types.js";
import { record } from "./record.js";

const ADAPTERS: Record<string, HarnessAdapter> = { "claude-code": claudeCode, codex };

const USAGE = `Usage: npm run record -- --harness <claude-code|codex> --scenario <file.yaml> [options]

Options:
  --cli-version <v>   install this exact CLI version into the sandbox (default: use the CLI on PATH)
  --model <m>         model to request
  --out <dir>         where captures are written (default: captures)
  --timeout <sec>     kill the CLI after this many seconds (default: 180)
  --extra-arg <a>     extra CLI argument; repeatable
  --keep-sandbox      keep the temporary sandbox for inspection

Credentials are read from the environment and passed through by name only:
  claude-code: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
  codex:       OPENAI_API_KEY or CODEX_API_KEY (or HOOKCOMPAT_COPY_CODEX_AUTH=1 to copy ~/.codex/auth.json)`;

async function main() {
  const { values } = parseArgs({
    options: {
      harness: { type: "string" },
      scenario: { type: "string" },
      "cli-version": { type: "string" },
      model: { type: "string" },
      out: { type: "string", default: "captures" },
      timeout: { type: "string", default: "180" },
      "extra-arg": { type: "string", multiple: true, default: [] },
      "keep-sandbox": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.harness || !values.scenario) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const adapter = ADAPTERS[values.harness];
  if (!adapter) throw new Error(`unknown harness "${values.harness}"`);
  const scenario = Scenario.parse(parseYaml(readFileSync(values.scenario, "utf8")));

  const result = await record({
    adapter,
    scenario,
    cliVersion: values["cli-version"],
    model: values.model,
    outDir: values.out,
    timeoutMs: Number(values.timeout) * 1000,
    extraArgs: values["extra-arg"],
    keepSandbox: values["keep-sandbox"],
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "ok" ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
