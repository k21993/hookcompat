# Replaying your hooks

The Action runs the hooks from your Claude Code settings against hook payloads recorded from real Claude Code versions, and checks each decision against what you expect. It makes no model calls.

```yaml
# hookcompat.yml, next to your workflow's checkout root
harness: claude-code
settings: .claude/settings.json   # matchers and commands are read from here
cases:
  - scenario: pretooluse-subagent # recorded scenario under data/fixtures/<harness>/<version>/
    expect: deny                  # or a list: [deny, ask]
    versions: [2.1.62, 2.1.63]    # optional; default is every recorded version
```

```yaml
- uses: actions/checkout@v4
- uses: k21993/hookcompat@main
  with:
    config: hookcompat.yml
```

For each case and version, the Action takes the first capture of the event (default `PreToolUse`), finds the hooks whose matcher matches its `tool_name`, runs them with the payload on stdin, and decodes the result. See `examples/consumer/` for a hook that breaks on 2.1.63.

## Results

Decisions are `allow`, `deny`, `ask`, `defer`, `no-opinion` (exit 0, no decision) and `error`. `no-opinion (no hook matched)` means no matcher matched the recorded `tool_name`.

The run fails if any case fails, if no fixture matches, or if no case was executed.

## Limits

- Claude Code `PreToolUse` and command hooks only. Anything else is reported as unsupported.
- Payloads are unmodified captures. Paths in them are redacted, so `cwd` is `/hookcompat/repo`, not your checkout.
- Hooks run with `sh -c` in the directory of `hookcompat.yml`, with `PATH`, `HOME` and `CLAUDE_PROJECT_DIR` set. Your hook's own runtime (Python, `jq` and so on) must be installed in your workflow.
- Linux runners only.
