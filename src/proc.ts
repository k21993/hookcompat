import { spawn } from "node:child_process";

export interface BoundedRunOptions {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface BoundedRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  launchError?: string;
}

/**
 * Runs a command in its own process group with a timeout and output caps.
 * On timeout, or once the main process exits, the whole group is killed so no children are left behind.
 */
export function runBounded(opts: BoundedRunOptions): Promise<BoundedRunResult> {
  const [cmd, ...args] = opts.argv;
  if (!cmd) throw new Error("runBounded: empty argv");

  return new Promise((resolve) => {
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], stdoutBytes: 0, stderrBytes: 0 };
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const bytesKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      const room = opts.maxOutputBytes - out[bytesKey];
      if (room <= 0) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (slice.length < chunk.length) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      out[stream].push(slice);
      out[bytesKey] += slice.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.stdin.on("error", () => {
      // the command may exit without reading stdin
    });

    const finish = (result: Partial<BoundedRunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(out.stdout).toString("utf8"),
        stderr: Buffer.concat(out.stderr).toString("utf8"),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        ...result,
      });
    };

    child.on("error", (err) => finish({ launchError: err.message }));
    // A child that outlives the main process can hold stdout/stderr open, delaying "close".
    // So on "exit", kill the rest of the group, then finish on "close" once output is drained.
    child.on("exit", (exitCode, signal) => {
      clearTimeout(timer);
      killGroup();
      // Fallback if a descendant escaped the group and still holds the pipes.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode, signal });
      }, 1_000).unref();
    });
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));

    child.stdin.end(opts.input ?? "");
  });
}
