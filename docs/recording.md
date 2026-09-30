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

## Safety

- The CLI runs in a throwaway HOME and git repo. Only `PATH`, locale variables and the named credential variables are passed through.
- Output is redacted (sandbox paths, your home directory, session and tool IDs), then scanned. If anything still looks like a secret, **nothing is written**.
- Captures are not committed to `main`. They go through review first.
