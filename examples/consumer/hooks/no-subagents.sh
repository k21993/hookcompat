#!/bin/sh
# Blocks subagent calls. Written for Claude Code before 2.1.63, when the subagent tool was "Task".
tool=$(jq -r .tool_name)
if [ "$tool" = "Task" ]; then
  echo "subagents are disabled in this repo" >&2
  exit 2
fi
exit 0
