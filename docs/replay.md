# Replaying your hooks

The Action runs the hooks from your Claude Code settings against hook payloads recorded from real Claude Code versions, and checks each decision against what you expect. It makes no model calls.

```yaml
# hookcompat.yml, next to your workflow's checkout root
harness: claude-code
settings: .claude/settings.json   # matchers and commands are read from here
# or, for a plugin: plugin: plugins/my-plugin   (uses its hooks/hooks.json and sets CLAUDE_PLUGIN_ROOT)
cases:
  - scenario: pretooluse-subagent # recorded scenario under data/fixtures/<harness>/<version>/
    expect: deny                  # or a list: [deny, ask]
    versions: [2.1.62, 2.1.63]    # optional; default is every recorded version
```

```yaml
- uses: actions/checkout@v4
- uses: k21993/hookcompat@v0.1.0
  with:
    config: hookcompat.yml
```

For each case and version, the Action takes the first capture of the event (default `PreToolUse`) in recording order, finds the hooks whose matcher matches its `tool_name`, runs them with the payload on stdin, and decodes the result. That capture must be reviewed; if it is not, the case is skipped and counted, and later captures are not tried, since they may be a different tool call. See `examples/consumer/` for a hook that checks `tool_name` for `Task` and so stops blocking on 2.1.63, where the tool is `Agent`.

## Results

Decisions are `allow`, `deny`, `ask`, `defer`, `no-opinion` (exit 0, no decision) and `error`. `no-opinion (no hook matched)` means no matcher matched the recorded `tool_name`. Matchers follow the docs, plus one known alias: the exact matcher `Task` still matches `Agent` (anthropics/claude-code#29677). Regex matchers are not given the alias.

Each configured case must have a reviewed fixture. If `versions` is set, every listed version must have one; an empty list is invalid. Without `versions`, unreviewed captures remain skipped and counted as long as the case has a reviewed fixture.

The run fails if any case fails, any selected case is unsupported, a required reviewed fixture is missing, or no case was executed. Missing coverage is reported even when other cases pass. A nested permission decision with a missing or mismatched `hookEventName` is decoded as `error`, not as a valid decision.

## Limits

- Claude Code `PreToolUse` and synchronous command hooks only. Matching hooks with `async: true` or `asyncRewake: true` are reported as unsupported and are not executed. Background hook results cannot establish a blocking decision. See the [Claude Code hook contract](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).
- Replay checks hook-command results for selected recorded inputs. It does not launch Claude Code or verify that a live tool action was blocked.
- Payloads are captures as recorded, with one change: the redacted repo path `/hookcompat/repo` (in `cwd` and paths under it) is replaced with the directory of `hookcompat.yml`, so hooks that find the repo from `cwd` work. Other redacted paths, such as `transcript_path`, point nowhere.
- Hooks run with `sh -c` in the directory of `hookcompat.yml`, with `PATH`, `HOME` and `CLAUDE_PROJECT_DIR` set, plus `CLAUDE_PLUGIN_ROOT` for a plugin. Your hook's own runtime (Python, `jq` and so on) must be installed in your workflow.
- Linux runners only.
