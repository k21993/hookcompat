import { describe, expect, it } from "vitest";
import { runBounded } from "../src/proc.js";

describe("runBounded", () => {
  it("finishes when the main process exits, even if a child keeps its pipes open", async () => {
    const started = Date.now();
    const res = await runBounded({
      argv: ["sh", "-c", "sleep 20 & exit 0"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a command that runs past the timeout", async () => {
    const res = await runBounded({
      argv: ["sh", "-c", "sleep 20"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 300,
      maxOutputBytes: 1024,
    });
    expect(res.timedOut).toBe(true);
  });
});
