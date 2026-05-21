# SlayZone Remote SSH Workflow — Implementation Plan

Companion to [`REMOTE-SSH-SPEC.md`](./REMOTE-SSH-SPEC.md). This document is the operational checklist for finishing remote SSH support.

## Status legend

- ✅ done — landed on `main`
- 🟡 partial — done in main but with known gaps
- 🔲 todo — not started

## What is already shipped

| Item | Commit | Status |
|---|---|---|
| `buildTransportSpawn` extracted to its own module, unit-tested | `c331d7f5` | ✅ |
| SSH path wraps in `tmux new-session -A -s slz-<sessionId>` for reattach | `c331d7f5` | ✅ |
| `pty.create` + `pty.transport_resolved` diagnostics with full `executionContext` | `c331d7f5` | ✅ |
| `testExecutionContext` probes `tmux` on the remote host | `c331d7f5` | ✅ |
| `EnvironmentTab` carries a "Sessions run inside tmux" info note | `c331d7f5` | ✅ |
| Absolute path resolution for `ssh.exe` on Windows (`%SystemRoot%\System32\OpenSSH\ssh.exe`) | `29e6d7f8` | ✅ |
| `pty.exit` diagnostic captures the buffer tail for opaque early exits | `29e6d7f8` | ✅ |
| `CreateProjectDialog` "On a remote machine (SSH)" option (host + remote workdir + shell + Test connection) | `eabed3d5` | ✅ |
| Skip local `pathExists` check when `execution_context.type !== 'host'` | `eabed3d5` | ✅ |
| `notify.sh` Windows path normalized to forward slashes | `3c6c7b56` | ✅ |
| Remote agent-hook installer (`~/.slayzone/hooks/notify.sh` + `~/.claude/settings.json` patch over ssh) — wired into `createPty` via `setRemoteHookInstaller` injection | `d6059eca` | ✅ |
| Reverse forward target uses `127.0.0.1` instead of `localhost` so Windows OpenSSH does not try `::1` first against an IPv4-only Express server | `d6059eca` | ✅ |
| **Phase 1 — `slay` CLI proxy on remote** (`/api/cli/exec` endpoint + `slay-proxy.sh` deployed on remote + `~/.slayzone/bin` prepended to remote PATH) | `9d17b4c8` | ✅ |
| **Phase 2 step 1** — transport-aware git command builder (`runGit`, `buildGitCommand`, `posixQuote`, `resolveProjectExecutionContext`, `resolveSshExecutable`) | `302d0450` | ✅ |
| **Phase 2 (refactor)** — `execGit` / `execGitFileList` route through `runGit` so optional `executionContext` propagates to every downstream call site without changing them | `44c6634e` | ✅ |
| **Phase 2 step 3** — `git:probeRepo(projectId)` IPC handler + renderer migration (Git tab no longer says "Not a git repository" for remote SSH projects) | `68adf646` | ✅ |
| **Phase 2 step 2** — thread optional `projectId` through 7 Git-tab read APIs (`getCurrentBranch`, `listBranches`, `hasUncommittedChanges`, `getRecentCommits`, `getStatusSummary`, `getRemoteUrl`, `getAheadBehindUpstream`); handlers resolve `executionContext` from project; `useConsolidatedGeneralData` threads `task.project_id` | `ec27fb53` | ✅ |
| **Phase 3 (read path)** — `ssh-fs.ts` module with `sshReadDir` + `sshReadFile`; `fs:readDir` / `fs:readFile` IPC accept optional `projectId` and route via ssh when context is ssh; `EditorFileTree` / `FileEditorView` thread `task.project_id`. File-write paths intentionally still host-only | uncommitted | 🟡 needs commit |

### Uncommitted at time of writing

`runGit` adapter foundation (Phase 2 step 1) sits uncommitted on `feature/remote-access`:

```
packages/domains/worktrees/src/main/run-git.ts        (new)
packages/domains/worktrees/src/main/run-git.test.ts   (new)
```

Suggested commit:

```
feat(worktrees): transport-aware runGit adapter (Phase 2 step 1)

Foundation for git over ssh. No callsite migration yet — existing
execGit() consumers continue to work locally. Subsequent commits will
migrate git-watcher, branch-ops, diff, and log to runGit so the Git
tab works against a remote working tree.
```

## Known remaining gaps (visible to the user today)

After committing the work above, opening a remote project still surfaces these problems:

1. **`slay` CLI on remote reads a stub local DB** — `slay projects list` returns only the locally-bootstrapped project, not the host's projects.
2. **Git tab says "Not a git repository"** — the git surface stats the project path on the host filesystem, where the remote path doesn't exist.
3. **Editor tab shows empty Files panel** — the file tree walks the host filesystem.
4. **MCP port changes across dev restarts mid-session** invalidate baked-in `SLAYZONE_AGENT_HOOK_URL` inside the tmux session env. Workaround today: kill the stale tmux session and let SlayZone re-create.
5. **Artifacts on remote** never land in the host blob-store.
6. **File watcher** does not see remote changes.
7. **Test execution** assumes local toolchain.

## Phased work

### Phase 1 — `slay` CLI proxy on remote (~3h)

Goal: any `slay <cmd>` invocation inside a remote agent shell talks to the SlayZone host, not a local stub DB.

1. New REST endpoint `POST /api/cli/exec` on the SlayZone host. Body:
   ```json
   {
     "args": ["projects", "list", "--json"],
     "cwd": "/home/carelogic/logmed",
     "env": {
       "SLAYZONE_PROJECT_ID": "8fe2…",
       "SLAYZONE_TASK_ID": "6e72…"
     }
   }
   ```
   Spawns the real `slay` binary on the host with the forwarded env, streams `stdout` + `stderr`, returns `{ stdout, stderr, exitCode }`. Loopback-only. Drop the request if the body fails a small zod schema.
2. Add a `slay-proxy.sh` script to `packages/shared/hooks/src/` (bundled like `notify.sh`):
   ```sh
   #!/bin/sh
   # Built-in proxy installed on remote SSH hosts so `slay <cmd>` rounds
   # back to the SlayZone host's real CLI via the reverse-forwarded MCP loop.
   [ -z "$SLAYZONE_MCP_PORT" ] && { echo "slay-proxy: SLAYZONE_MCP_PORT not set" >&2; exit 1; }
   payload=$(jq -nc --arg cwd "$PWD" \
                    --arg pid "$SLAYZONE_PROJECT_ID" \
                    --arg tid "$SLAYZONE_TASK_ID" \
                    --args -- "$@" \
                    '{cwd:$cwd, env:{SLAYZONE_PROJECT_ID:$pid, SLAYZONE_TASK_ID:$tid}, args:$ARGS.positional}')
   resp=$(curl -fsS --connect-timeout 5 \
     -H 'Content-Type: application/json' \
     --data-binary "$payload" \
     "http://127.0.0.1:$SLAYZONE_MCP_PORT/api/cli/exec") || exit 1
   printf '%s' "$resp" | jq -r '.stdout'
   printf '%s' "$resp" | jq -r '.stderr' >&2
   exit $(printf '%s' "$resp" | jq -r '.exitCode')
   ```
3. Extend `remote-hook-installer.ts` to also deploy `~/.slayzone/bin/slay`, chmod 0755, and make sure `~/.slayzone/bin` is on the agent shell's PATH (either via a small `~/.profile` patch with a marker comment, or by exporting `PATH` in the tmux inner script alongside the other `export` lines).
4. Add a CLI-side e2e test that hits `/api/cli/exec` and asserts that `slay projects list --json` returns both the local and remote projects.

### Phase 2 — Git tab + Worktrees over SSH (~1 week)

The worktrees domain (`packages/domains/worktrees/src/main`) wraps `git` calls in a `spawn` helper that always targets the local fs. We need a transport-aware variant.

1. Pull the `spawn` helper out of `exec-async.ts` and replace it with a `runGit(projectId, args, cwd?)` adapter that:
   - looks up `project.execution_context`,
   - for `host`: runs locally (today's path),
   - for `ssh`: prefixes `ssh -- <target>` and quotes args for the remote shell, using the same MCP port-forward env if needed.
2. Update every `git` consumer in the worktrees domain to call `runGit` with the project context attached. Audit:
   - `git-watcher.ts` — switch the poll from `fs.watch` to a periodic `git status --porcelain` via `runGit` (slow but works). Mark this as "polled, not live" in the UI.
   - `branch-ops.ts`, `diff.ts`, `log.ts` — straightforward.
3. New IPC handler `git:probeRepo(projectId)` so the renderer can call `git rev-parse --is-inside-work-tree` through the transport and display the right state on the Git tab.
4. Renderer: `Git` tab reads `git:probeRepo` rather than relying on local fs existence.

### Phase 3 — Editor + file tree over SSH (~1 week)

The editor's file panel today calls `window.api.files.*` which all read local fs.

1. Introduce a `RemoteFs` abstraction with the small subset the renderer actually needs: `list(dir)`, `read(path)`, `write(path, contents)`, `stat(path)`, `watch(path)?`.
2. Implement two backends:
   - `localFs` — current behaviour
   - `sshFs` — `ssh -- <target> ls -la …`, `cat`, `tee`, `stat`. Batch listings via `find -maxdepth 1 -printf` for speed.
3. Route `window.api.files.*` through a per-project `getFsForProject(projectId)` that picks the backend based on `execution_context`.
4. For `watch`, start with periodic polling at ~2s and a manual "Refresh" button. Optional follow-up: pipe `inotifywait -m` over ssh into a parsed stream.
5. Disable file-write paths if the remote round-trip fails — never silently lose user edits.

### Phase 4 — Artifacts on remote (~3 days)

Two options. Pick during Phase 3 once we have a clearer feel for fs round-trip cost.

**Option A — push from remote.** Bundle a small `slay artifact upload` helper that the agent invokes (via the slay-proxy from Phase 1). Host writes the artifact into the local blob-store and indexes it normally.

**Option B — SCP on task completion.** When `Stop` hook fires, sync `~/.slayzone/artifacts/<taskId>/` from remote to host. Simpler but lossy (no live updates).

Recommend Option A: matches the slay-proxy pattern.

### Phase 5 — Polish + stability (~2 days)

1. **Stable MCP port across dev restarts.** Either:
   - Make `SLAYZONE_MCP_PORT` env override the dynamic-port pick at boot, or
   - On respawn, rewrite the tmux session's env via `tmux send-keys` of a small `export` re-issue before claude resumes.
2. **`testExecutionContext`** should also probe `jq`, `curl`, `git` so the user gets actionable errors in the project settings test button.
3. **Status indicator UX** — when remote hooks are not yet installed (e.g. `pty.remote_hooks_install_failed`), show a yellow dot + a tooltip explaining "hooks not deployed, status reporting may lag".
4. **Cleanup of stale tmux sessions.** When the user deletes a project or changes its host, optionally kill the leftover `slz-*` sessions on the previous host.
5. **Documentation** — add a "Working remote" section to `README.md` linking to the spec.

## Suggested order of attack

1. Commit the uncommitted Phase-0 changes listed above.
2. Knock out Phase 1 (slay CLI proxy) — biggest immediate quality-of-life win for the agent.
3. Phase 2 (git) — unlocks the Git tab, which is the most-visited surface after the terminal.
4. Phase 3 (editor) — unlocks the file panel and most artifact previews.
5. Phase 4 (artifacts) + Phase 5 (polish) in either order.

## Test plan summary

For each phase, add at least:

- A **unit test** at the boundary (`runGit` adapter, `RemoteFs` backend, `slay-proxy` script).
- An **integration test** with a real ssh target via `OpenSSH-portable` in a CI image (or skipped behind `SLAYZONE_E2E_SSH=1`).
- A **regression test** confirming local-host projects still behave exactly the same on every surface.

## Open architectural calls to make during Phase 2/3

- Should `runGit` and `RemoteFs` share a single "ssh session pool" so we are not paying TCP-handshake + key exchange on every operation? Probably yes via `ControlMaster + ControlPersist`. Defer until we measure.
- Where does the per-project `execution_context` live in the React tree — context provider on the project page, or threaded as prop from `App.tsx`? Suggest a `useProjectExecutionContext()` hook backed by the existing project query.

## Diagnostics added so far (use during follow-up sessions)

These exist in `packages/domains/terminal/src/main/pty-manager.ts` and write to `slayzone.dev.diagnostics.sqlite` / `slayzone.diagnostics.sqlite`:

- `pty.create` — now logs `executionContext`
- `pty.transport_resolved` — shows `transportFile` (absolute path), `transportArgsCount`, `transportCwd`
- `pty.exit` — includes `bufferTail` (last 800 chars of the ring buffer, ANSI-stripped)
- `pty.remote_hooks_installed` / `pty.remote_hooks_install_failed`

To inspect from any shell:

```sh
python -c "
import sqlite3, json
con = sqlite3.connect('C:/Users/abom/AppData/Roaming/slayzone/slayzone.dev.diagnostics.sqlite')
con.row_factory = sqlite3.Row
cur = con.execute(\"SELECT ts_ms, event, payload_json FROM diagnostics_events WHERE event LIKE 'pty.%' ORDER BY ts_ms DESC LIMIT 10\")
for r in cur.fetchall():
    p = r['payload_json']
    try: p = json.loads(p)
    except: pass
    print('---', r['ts_ms'], r['event'])
    print(json.dumps(p, indent=2)[:1200])
"
```
