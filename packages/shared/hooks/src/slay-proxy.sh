#!/bin/sh
# SlayZone `slay` CLI proxy for remote SSH hosts.
#
# Installed by the app at ~/.slayzone/bin/slay (mode 0755) when a project's
# execution_context is `ssh`. Forwards the invocation to the host SlayZone
# instance via the reverse-forwarded MCP loopback so `slay <cmd>` inside a
# remote agent shell sees the real host DB (projects, tasks, …) rather than
# a stub local DB the agent might have bootstrapped.
#
# Required env (injected at PTY spawn by transport-spawn / buildMcpEnv):
#   SLAYZONE_MCP_PORT   - host MCP loopback port reachable via -R tunnel
# Optional:
#   SLAYZONE_TASK_ID    - active task id, forwarded to the host CLI
#   SLAYZONE_PROJECT_ID - active project id, forwarded to the host CLI
#
# Contract:
#   - exit code mirrors the host CLI exit
#   - stdout / stderr streamed back verbatim
#   - quiet failure with exit 1 + a single stderr line on transport/parse errors
#
# Dependencies on remote: curl, jq. Both are probed by testExecutionContext
# before the project is allowed to spawn; this script just bails fast if
# either is missing.

set -e

if [ -z "$SLAYZONE_MCP_PORT" ]; then
  printf 'slay-proxy: SLAYZONE_MCP_PORT not set (run slay from inside a SlayZone-spawned remote shell)\n' >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  printf 'slay-proxy: curl not found on remote host\n' >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'slay-proxy: jq not found on remote host\n' >&2
  exit 1
fi

# Build the request payload. Use jq -n + --args so jq handles all escaping
# (paths with spaces, args with quotes, unicode, etc).
PAYLOAD=$(
  jq -nc \
    --arg cwd "$PWD" \
    --arg pid "${SLAYZONE_PROJECT_ID:-}" \
    --arg tid "${SLAYZONE_TASK_ID:-}" \
    --args -- "$@" \
    '{
       cwd: $cwd,
       env: ({} + (if $pid == "" then {} else {SLAYZONE_PROJECT_ID: $pid} end)
                + (if $tid == "" then {} else {SLAYZONE_TASK_ID: $tid} end)),
       args: $ARGS.positional
     }'
)

# Capture status separately from stdout via a trailing line we strip back off.
RESP=$(
  curl -fsS \
    --connect-timeout 5 \
    --max-time 120 \
    -H 'Content-Type: application/json' \
    --data-binary "$PAYLOAD" \
    "http://127.0.0.1:$SLAYZONE_MCP_PORT/api/cli/exec"
) || {
  printf 'slay-proxy: failed to reach SlayZone host at 127.0.0.1:%s/api/cli/exec\n' "$SLAYZONE_MCP_PORT" >&2
  exit 1
}

STDOUT=$(printf '%s' "$RESP" | jq -r '.stdout // ""')
STDERR=$(printf '%s' "$RESP" | jq -r '.stderr // ""')
EXIT=$(printf '%s' "$RESP" | jq -r '.exitCode // 1')

[ -n "$STDOUT" ] && printf '%s' "$STDOUT"
[ -n "$STDERR" ] && printf '%s' "$STDERR" >&2

# `set -e` would abort before exit if EXIT is non-zero; switch off to honour it.
set +e
exit "$EXIT"
