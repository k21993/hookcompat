// GitHub Action entry. Also runs locally: npm run replay -- <hookcompat.yml>
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replay, summary } from "./replay.js";

// Bundled to action/index.mjs, so data/ is one level up in both layouts.
const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

const configPath = process.env.INPUT_CONFIG || process.argv[2] || "hookcompat.yml";

try {
  const report = await replay(configPath, DATA_DIR);
  const md = summary(report);
  process.stdout.write(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  for (const r of report.results.filter((r) => r.status === "fail")) {
    console.log(
      `::error title=hookcompat ${r.scenario} ${report.harness} ${r.version}::expected ${r.expected.join(" or ")}, got ${r.got?.kind}${r.got?.detail ? ` (${r.got.detail})` : ""} for tool_name "${r.toolName}"`,
    );
  }
  if (report.error) console.log(`::error title=hookcompat::${report.error}`);
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.log(`::error title=hookcompat::${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
