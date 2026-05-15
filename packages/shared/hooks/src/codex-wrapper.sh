#!/bin/bash
# slayzone codex wrapper v1
#
# Codex's native notify=[...] callback only fires on completion (Stop). To
# surface Start + PermissionRequest, this wrapper shadows the `codex` binary
# via PATH prepend (~/.slayzone/bin) and:
#   1. Enables CODEX_TUI_RECORD_SESSION + process-scoped session log
#   2. Spawns a background `tail -F` watcher that greps the JSONL log for
#      UserTurn (Start) and *_approval_request (PermissionRequest), then
#      POSTs synthetic events via notify.sh
#   3. Execs the real codex binary with --enable hooks and the native notify
#      callback wired to the same notify.sh (handles Stop)
#
# Concurrent codex sessions share Codex's global rollout dir — DO NOT tail
# that. Process-scoped log via $$ + epoch keeps sessions isolated. Watcher
# subprocess tree is cleaned up via pgrep trap on EXIT/HUP/INT/TERM, mirroring
# Superset's proven cleanup logic for macOS `tail -F` zombie risk.

_slayzone_debug_enabled="0"
case "$SLAYZONE_DEBUG_HOOKS" in
  1|true|TRUE|True|yes|YES|on|ON) _slayzone_debug_enabled="1" ;;
esac
if [ "$_slayzone_debug_enabled" != "1" ] && { [ "$SLAYZONE_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; }; then
  _slayzone_debug_enabled="1"
fi

_slayzone_home_dir="${SLAYZONE_HOME_DIR:-$HOME/.slayzone}"
_slayzone_notify_path="${_slayzone_home_dir}/hooks/notify.sh"
_slayzone_debug_log="${SLAYZONE_HOOK_DEBUG_LOG:-/tmp/slayzone-codex-hooks.log}"
_slayzone_has_context="0"
[ -n "$SLAYZONE_TASK_ID$SLAYZONE_AGENT_HOOK_URL" ] && _slayzone_has_context="1"
SLAYZONE_CODEX_SESSION_WATCHER_PID=""
SLAYZONE_CODEX_SESSION_LOG=""

_slayzone_debug() {
  [ "$_slayzone_debug_enabled" = "1" ] || return 0
  printf '%s [codex-wrapper] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "$_slayzone_debug_log" 2>/dev/null || true
}

# Skip self when resolving real codex — wrapper lives at $SLAYZONE_HOME_DIR/bin.
REAL_BIN=$(which -a codex 2>/dev/null | grep -v "^${_slayzone_home_dir}/bin/codex$" | head -1)
if [ -z "$REAL_BIN" ]; then
  echo "slayzone: codex CLI not found on PATH (excluding wrapper). Install codex." >&2
  exit 127
fi
_slayzone_debug "REAL_BIN=$REAL_BIN"

_slayzone_child_pids_for() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
    return 0
  fi
  ps -axo pid=,ppid= 2>/dev/null | awk -v ppid="$1" '$2 == ppid { print $1 }' 2>/dev/null || true
}

_slayzone_cleanup_session_watcher() {
  if [ -n "$SLAYZONE_CODEX_SESSION_WATCHER_PID" ]; then
    _slayzone_watcher_pid="$SLAYZONE_CODEX_SESSION_WATCHER_PID"
    _slayzone_child_pids="$(_slayzone_child_pids_for "$_slayzone_watcher_pid" | tr '\n' ' ')"
    for _slayzone_child_pid in $_slayzone_child_pids; do
      kill -TERM "$_slayzone_child_pid" >/dev/null 2>&1 || true
    done
    kill -TERM "$_slayzone_watcher_pid" >/dev/null 2>&1 || true
    sleep 0.2
    _slayzone_child_pids="$_slayzone_child_pids $(_slayzone_child_pids_for "$_slayzone_watcher_pid" | tr '\n' ' ')"
    for _slayzone_child_pid in $_slayzone_child_pids; do
      kill -KILL "$_slayzone_child_pid" >/dev/null 2>&1 || true
    done
    kill -KILL "$_slayzone_watcher_pid" >/dev/null 2>&1 || true
    _slayzone_debug "session watcher cleanup signaled pid=$_slayzone_watcher_pid"
    SLAYZONE_CODEX_SESSION_WATCHER_PID=""
  fi
  if [ -n "$SLAYZONE_CODEX_SESSION_LOG" ]; then
    rm -f "$SLAYZONE_CODEX_SESSION_LOG" >/dev/null 2>&1 || true
    _slayzone_debug "session log removed path=$SLAYZONE_CODEX_SESSION_LOG"
    SLAYZONE_CODEX_SESSION_LOG=""
  fi
}

_slayzone_exit_trap() {
  _slayzone_status=$?
  trap - EXIT HUP INT TERM
  _slayzone_cleanup_session_watcher
  exit "$_slayzone_status"
}

trap _slayzone_exit_trap EXIT HUP INT TERM

if [ "$_slayzone_has_context" = "1" ] && [ -f "$_slayzone_notify_path" ]; then
  # Honor pre-set path (pty-manager pre-generates one for cleanup tracking);
  # otherwise mint a process-scoped path here.
  export CODEX_TUI_RECORD_SESSION="${CODEX_TUI_RECORD_SESSION:-1}"
  export CODEX_TUI_SESSION_LOG_PATH="${CODEX_TUI_SESSION_LOG_PATH:-${TMPDIR:-/tmp}/slayzone-codex-session-$$_$(date +%s).jsonl}"
  SLAYZONE_CODEX_SESSION_LOG="$CODEX_TUI_SESSION_LOG_PATH"
  _slayzone_debug "session watcher starting taskId=$SLAYZONE_TASK_ID log=$CODEX_TUI_SESSION_LOG_PATH notify=$_slayzone_notify_path"

  (
    _slayzone_notify="$_slayzone_notify_path"
    _slayzone_session_log="$CODEX_TUI_SESSION_LOG_PATH"

    _slayzone_emit_event() {
      _slayzone_payload=$(printf '{"hook_event_name":"%s"}' "$1")
      _slayzone_debug "emitting $1 via $_slayzone_notify"
      bash "$_slayzone_notify" "$_slayzone_payload" >/dev/null 2>&1 || true
    }

    # 30s wait for session log to appear. Slow filesystems (APFS under load)
    # can delay creation; on timeout the watcher silently exits.
    _slayzone_i=0
    while [ ! -f "$_slayzone_session_log" ] && [ "$_slayzone_i" -lt 300 ]; do
      _slayzone_i=$((_slayzone_i + 1))
      sleep 0.1
    done
    if [ ! -f "$_slayzone_session_log" ]; then
      _slayzone_debug "session log not found after 30s path=$_slayzone_session_log"
      exit 0
    fi
    _slayzone_debug "watching session=$_slayzone_session_log"

    tail -n +1 -F "$_slayzone_session_log" 2>/dev/null | while IFS= read -r _slayzone_line; do
      case "$_slayzone_line" in
        *'"dir":"from_tui"'*'"kind":"op"'*'"UserTurn"'*) _slayzone_emit_event "Start" ;;
        *'_approval_request"'*) _slayzone_emit_event "PermissionRequest" ;;
      esac
    done
  ) 2>/dev/null &
  SLAYZONE_CODEX_SESSION_WATCHER_PID=$!
  _slayzone_debug "session watcher pid=$SLAYZONE_CODEX_SESSION_WATCHER_PID"
else
  _slayzone_notify_exists="0"
  [ -f "$_slayzone_notify_path" ] && _slayzone_notify_exists="1"
  _slayzone_debug "session watcher disabled hasContext=$_slayzone_has_context taskId=$SLAYZONE_TASK_ID notifyExists=$_slayzone_notify_exists notify=$_slayzone_notify_path"
fi

# `hooks` (formerly `codex_hooks`) is stable + default-enabled in codex >=0.129;
# the legacy `notify=[...]` callback remains the completion source.
"$REAL_BIN" --enable hooks -c "notify=[\"bash\",\"$_slayzone_notify_path\"]" "$@"
SLAYZONE_CODEX_STATUS=$?
_slayzone_debug "codex exited status=$SLAYZONE_CODEX_STATUS"

_slayzone_cleanup_session_watcher

trap - EXIT HUP INT TERM
exit "$SLAYZONE_CODEX_STATUS"
