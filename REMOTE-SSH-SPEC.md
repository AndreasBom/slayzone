# SlayZone Remote SSH Workflow — Spec

> Goal: run AI coding sessions on a remote Linux host (working in a remote git repo) while the SlayZone GUI keeps running locally on Windows/macOS. The GUI should feel identical to a local-project workflow — the user should not have to babysit ssh, tmux, or remote tooling.

## Why

The user's daily workflow is to SSH into a Linux dev box, attach to a tmux session there, and let `claude` work on the repo. SlayZone today assumes the project repo is on the same machine the GUI runs on, so most of its surfaces (terminal, git tab, editor, artifacts, file watcher) silently fall back to the local filesystem when the repo actually lives elsewhere.

## In scope

- Agent terminals spawned on a remote SSH host (`carelogic-dev` style), inside a tmux session, with reattach across SSH drops and SlayZone restarts.
- Project-level `execution_context: ssh` set via UI from Create-Project or Project-Settings.
- Working-directory path that lives on the remote, not the host.
- Claude Code agent lifecycle hooks (`SessionStart`, `PreToolUse`, `Stop`, …) reaching SlayZone over the reverse-forwarded MCP port → status indicator reflects what the remote agent is actually doing.
- `slay` CLI invocations from inside the remote agent shell hit the local SlayZone host (so `slay projects list` shows every project the host knows about, not whatever lives in a stub DB on remote).
- Git tab: status, branch, log, diff, file changes — all read from the remote working tree.
- Editor tab: file tree, file open, file save — all on the remote filesystem.
- Artifacts: agent-emitted files surfaced in the UI even when generated on remote.
- File watcher: live updates when files change on the remote.

## Out of scope (for now)

- Native Linux/macOS `slay` binary builds. Remote uses a thin proxy script.
- Docker execution context — focus is ssh first.
- Multi-host parallel sessions (one project = one host for now).
- Password-based SSH auth (key-only).
- Mobile / non-tty paths.

## Non-functional requirements

- **No regressions for local projects.** Every change must keep the host-mode flow byte-identical when `execution_context` is `host` or absent.
- **Loopback-only auth.** All HTTP endpoints stay bound to `127.0.0.1`. Remote agents reach them exclusively via SSH reverse forward — no public surface gets added.
- **Reattach > respawn.** When SlayZone restarts or SSH drops, the remote tmux session must still be there and the agent must reconnect to its existing state.
- **Best-effort, never blocking.** When remote-only plumbing fails (hooks install, git probe), the spawn must still proceed. Bad status reporting is better than refusing to launch the agent.
- **Idempotent install steps.** Re-running setup on a host must converge on the same state, even after partial failures.

## High-level architecture

```
┌─ SlayZone GUI (Electron, Windows) ────────────────────────────┐
│                                                                │
│  ┌─ pty-manager ──────┐    ┌─ MCP server (127.0.0.1:PORT) ──┐  │
│  │ spawns ssh + tmux  │    │ /api/agent-hook              │  │
│  │ on remote          │    │ /api/cli/exec                │  │
│  └───────┬────────────┘    │ /mcp                         │  │
│          │ ssh -t -R       └────────┬─────────────────────┘  │
│          │                          ▲                          │
└──────────┼──────────────────────────┼──────────────────────────┘
           │ tunnel               loopback POST
           ▼                          │
┌─ Remote Linux host ─────────────────┴──────────────────────────┐
│                                                                │
│  tmux session slz-<sessionId>                                  │
│    └─ bash -i -l (cwd=remote workdir, env = SLAYZONE_* vars)   │
│        └─ claude                                               │
│            ├─ hooks → ~/.slayzone/hooks/notify.sh              │
│            │    └─ curl POST http://127.0.0.1:PORT/api/agent-hook
│            └─ ~/.slayzone/bin/slay (proxy)                     │
│                 └─ curl POST http://127.0.0.1:PORT/api/cli/exec │
│                      └─ host spawns real `slay` w/ forwarded env│
└────────────────────────────────────────────────────────────────┘
```

Three things flow over the ssh reverse tunnel back to the host:
1. **Hook events** (`/api/agent-hook`) — drive the status indicator.
2. **CLI proxy** (`/api/cli/exec`) — route every `slay <cmd>` on remote into the real CLI on the host.
3. **Git + filesystem** queries — every read/write surface that today touches local fs must instead route over ssh when `execution_context.type === 'ssh'`.

## Boundaries

- Execution context lives on the project (`projects.execution_context`). Per-task override is intentionally not part of this scope.
- Tmux session name is `slz-<sanitized sessionId>` — deterministic per pane so reattach works without a DB column.
- `slay` proxy on remote is a 30-line `sh` script that curls the host. It is not a port of the CLI.
- Hook installer treats remote `~/.claude/settings.json` as user-owned — it preserves every entry it didn't create, identified by the `_slayzoneManaged: true` marker.

## Open questions

- **Multiple slayzone instances** (dev + prod, two windows) sharing one remote host: the second instance will reattach to the first's tmux session and clobber the env if the MCP port differs. Likely needs a stable per-instance MCP port or a per-instance tmux session prefix.
- **Artifact storage:** push from remote → host REST endpoint, or NFS mount on a shared share, or SCP on task end. Each has tradeoffs. Defer until git tab is working so we have a clearer feel.
- **File watcher semantics:** poll over ssh, inotify-stream piped over ssh, or "no live updates on remote, manual refresh button" — pick the simplest that doesn't lie to the user.
- **Editor concurrency:** if a user edits a file in SlayZone's editor while the agent edits the same file on remote, who wins? Probably last-writer-wins with a stat-mtime conflict warning.
