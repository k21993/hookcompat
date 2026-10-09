# hookcompat

Claude Code changes the payloads it sends to hooks between versions, sometimes without a changelog entry. A hook that worked last month can stop enforcing anything, with no error.

hookcompat replays hook payloads recorded from real Claude Code versions against your hooks in CI, and fails when a hook's decision is not what you expect.

Example: Claude Code 2.1.63 renamed the subagent tool from `Task` to `Agent` in hook payloads ([anthropics/claude-code#29677](https://github.com/anthropics/claude-code/issues/29677)). A hook that blocks subagents by checking `tool_name == "Task"` denies on 2.1.62 and silently allows on 2.1.63. hookcompat catches it:

| Result | Version | tool_name | Expected | Got |
|---|---|---|---|---|
| PASS | 2.1.62 | Task | deny | deny |
| FAIL | 2.1.63 | Agent | deny | no-opinion |

## Usage

Add `hookcompat.yml` to your repo:

```yaml
harness: claude-code
settings: .claude/settings.json
cases:
  - scenario: pretooluse-subagent
    expect: deny
```

And a workflow:

```yaml
on: [pull_request]
jobs:
  hookcompat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: k21993/hookcompat@v0.1.0
        with:
          config: hookcompat.yml
```

The Action reads your matchers and hook commands from the settings file, runs the matching hooks with each recorded payload on stdin, and writes a results table to the job summary. Your hooks' own runtime (Python, `jq` and so on) must be installed in the job. See [examples/consumer](examples/consumer) and [docs/replay.md](docs/replay.md).

## Where the payloads come from

- Each fixture is a hook input captured from a real Claude Code run, with paths, IDs and secrets redacted. See [docs/recording.md](docs/recording.md).
- Fixtures are labelled with the CLI version and model, and keep the run's context (argv, hook config, OS).
- Replay only uses fixtures marked `reviewed`. Every configured case and explicitly requested version needs a reviewed fixture. Other unreviewed captures are skipped and counted.
- Replay makes no model calls and needs no API keys.

## Tested against

[Trellis](https://github.com/mindfold-ai/Trellis), whose PreToolUse hook adds context to its own subagents:

- v0.3.5 checks `tool_name == "Task"`, so on 2.1.63 its hook skips the `research` subagent. hookcompat fails it on `pretooluse-research-subagent`.
- v0.3.6 accepts `Task` and `Agent` and passes.
- main (f089cb3) passes `pretooluse-trellis-research-subagent` on 2.1.62, 2.1.63 and 2.1.286.

This shows the hook matched and answered `allow`. It does not check the context the hook added (`updatedInput`).

## Scope and limits

- Replay: Claude Code `PreToolUse` synchronous command hooks only. Unsupported cases fail the run, even when other cases pass. See [replay limits](docs/replay.md#limits).
- A passing replay establishes the expected hook-command decision for the selected recorded inputs. Live tool enforcement is not tested.
- Recording: Claude Code and Codex, run by hand on Linux or macOS.
- It checks the decision (`allow`, `deny`, `ask`, `defer`, `no-opinion`, `error`), not other output such as `updatedInput`.
- Scenarios:
  - `pretooluse-subagent`: built-in subagent, on 2.1.62 and 2.1.63.
  - `pretooluse-research-subagent`: a project subagent named `research`, on 2.1.62 and 2.1.63.
  - `pretooluse-trellis-research-subagent`: a project subagent named `trellis-research`, on 2.1.62, 2.1.63 and 2.1.286.
- Linux runners only.

## License

MIT
