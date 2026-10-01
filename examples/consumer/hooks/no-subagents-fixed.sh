#!/bin/sh
# Blocks subagent calls under both names: "Task" before Claude Code 2.1.63, "Agent" from 2.1.63.
tool=$(jq -r .tool_name)
if [ "$tool" = "Task" ] || [ "$tool" = "Agent" ]; then
  echo "subagents are disabled in this repo" >&2
  exit 2
fi
exit 0
