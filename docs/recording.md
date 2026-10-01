# Recording captures (day 1)

The first sprint step is to confirm, by hand, that hooks fire when each CLI runs headless.
Run these on Linux with the CLIs' own credentials in your environment.

```sh
npm ci

# Claude Code: uses `claude` on PATH, or pass --cli-version to install an exact version into the sandbox
export ANTHROPIC_API_KEY=...          # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
npm run record -- --harness claude-code --scenario scenarios/pretooluse-shell-write.yaml
npm run record -- --harness claude-code --scenario scenarios/pretooluse-shell-write-deny.yaml

# Codex
export OPENAI_API_KEY=...             # or HOOKCOMPAT_COPY_CODEX_AUTH=1 to copy ~/.codex/auth.json into the sandbox
npm run record -- --harness codex --scenario scenarios/pretooluse-shell-write.yaml
npm run record -- --harness codex --scenario scenarios/pretooluse-shell-write-deny.yaml
```

Each run prints a JSON summary and writes to `captures/<harness>/<cliVersion>/<scenario>/<runId>/`:

- `NN-<Event>-<id>.json`: one untouched (redacted) hook input per invocation, marked `unreviewed`.
- `recording.json`: the capture context (CLI version, model, argv, OS, the sanitised hook config and its hash, the env allowlist), what the capture hook answered for each event, whether the marker file was created, and the tail of the CLI's output.

## What day 1 needs to answer

| Question | Where to look |
|---|---|
| Do hooks fire at all under `claude -p` and `codex exec`? | `eventsCaptured` in the summary; `status` is `no-captures` if nothing fired |
| Which events fire, and in what order? | `eventsCaptured` |
| In the allow run, was the marker created? | `markerCreated: true` |
| In the deny run: was the specific write attempted, did our hook answer deny, and is the marker absent? | a PreToolUse capture whose `tool_input` contains the marker name; `evidence` shows `responded: "deny"` for it; `markerCreated: false` |

If a flag the adapters pass is wrong for your CLI version, adjust without code changes using `--extra-arg`, and keep `--keep-sandbox` to inspect what happened.

## Known breakage: subagent tool rename (Claude Code 2.1.63)

Claude Code 2.1.63 renamed the subagent tool from `Task` to `Agent` in hook payloads, without a changelog entry ([anthropics/claude-code#29677](https://github.com/anthropics/claude-code/issues/29677)). Hook scripts that checked `tool_name == "Task"` silently stopped enforcing; a settings matcher of `Task` still matched. Record both sides:

```sh
npm run record -- --harness claude-code --cli-version 2.1.62 --scenario scenarios/pretooluse-subagent.yaml
npm run record -- --harness claude-code --cli-version 2.1.63 --scenario scenarios/pretooluse-subagent.yaml
```

Expected: a PreToolUse capture with `tool_name: "Task"` on 2.1.62 and `"Agent"` on 2.1.63.

Claude Code hook payloads carry no model, so the recorder reads it from the CLI's stream-json output. The 2.1.62 and 2.1.63 fixtures were recorded before that and show `model: "unknown"`; their `run.stdoutTail` shows `claude-sonnet-4-6`.

## Safety

- The CLI runs in a throwaway HOME and git repo. Only `PATH`, locale variables and the named credential variables are passed through.
- `--cli-version` installs run npm with only `PATH` and proxy/CA variables, so install scripts never see credentials. An install that fails or takes over 5 minutes ends the run as `install-failed`.
- Output is redacted (sandbox paths, your home directory, session and tool IDs), then scanned. If anything still looks like a secret, **nothing is written**.
- Captures are not committed to `main`. They go through review first.

## Platform

Linux only for now. Two known gaps before other platforms:

- `runBounded` kills timed-out runs by process group (`kill(-pid)`), which Windows lacks.
- `onPath` finds the CLI with `sh -c "command -v"`.
