# Remote SSH Resilience — Implementation Plan (v6)

Goal: when a remote SSH host reboots (or the agent process is killed
for any other reason), the user can continue their SlayZone task
without losing scrollback or the agent's conversation. Three
capabilities:

1. **tmux state persistence** — tmux-resurrect/continuum save the pane
   layout and scrollback. After reboot the user reattaches and sees
   the previous output preserved. The agent process itself does NOT
   restart automatically inside the restored tmux session (resurrect
   does not re-exec arbitrary CLIs). The user re-opens the task in
   SlayZone; existing `existingConversationId` plumbing
   (`pty-manager.ts:769-773`) picks the agent's `resume_command`
   template using the stored `provider_config[mode].conversationId`,
   so the agent comes back into the conversation it left. Auto
   continuum-restore is deferred (see Out of scope) — until then the
   user presses `prefix + Ctrl-R` once after reboot to invoke
   resurrect manually.
2. **Kill remote tmux from the host UI** — right-click on terminal
   tab + Project Settings → "Remote sessions" panel that lists
   `slz-*` sessions and lets the user kill them.
3. **Agent session resume + fallback** — `SessionEnd` clears the
   stored conversation id so `/exit` doesn't auto-resume into a
   closed conversation; if a resume attempt fails (id missing on
   remote disk), the existing `claude-adapter.ts:69` SESSION_NOT_FOUND
   error path is wired to clear the id and respawn fresh.

**Assumption (user-confirmed)**: a task lives its entire lifetime on
the host it was created on. Tasks never migrate between hosts. This
lets us reuse the existing single-`conversationId`-per-task schema
without target scoping. v5 deliberately drops v3/v4's
`conversationsByTarget` complexity.

## Revision history

- **v1–v4** all rejected. Round 4 introduced 5 CRITICALs concentrated
  in the multi-target accessor changes (`conversationsByTarget`
  signature change, `conversationIdVersion` race protection without
  transaction, Commit 1/4 bridge gap, etc.). v5 collapses that whole
  branch of complexity by dropping the multi-target requirement.
- **v5** dropped multi-target accessors (CCs round-4 #1-3), merged
  Commits 1+2, added `ensureRemoteWrapper`, dropped 3a no-op probe,
  fixed flock probe naming, specced instance-id IPC. Rejected
  round-5 for THREE factual errors at the helper layer:
  `clearProviderConversationId` didn't exist;
  `resolveProjectExecutionContext` already existed at a different
  path; the resume watcher was placed on the wrong adapter
  interface. Plus `ensureRemoteWrapper` scope was hand-wavy.
- **v6** (this revision) fixes those factual errors and the round-5
  MAJORs without redesigning. No new mechanism — just correct
  citations and tightened scope.

---

## Existing infrastructure (re-verified)

- **tmux wrap**: `transport-spawn.ts:49` `tmuxSessionNameFor()`
  sanitizes `:`/`.` → `_`. `transport-spawn.ts:121-126` invokes
  `tmux new-session -A -s <name>` against the *default* socket today.
  Inner script ends with `exec ${remoteShell} -i -l` — anything after
  that line never runs. The `sessionId === undefined` fallback runs
  innerScript bare with no tmux wrap.
- **Local kill**: `pty-manager.ts:1847-1892` `killPty(sessionId)`
  SIGKILLs the local ssh process; watchdog at line 389 finalizes on
  timeout, natural onExit otherwise. Local-only — remote tmux is left
  running.
- **Shutdown wait primitive**: `shutdownWaiters` Set at
  `pty-manager.ts:146`, drained-once-cleared by `finalizeSessionExit`
  at lines 1075-1083; `finalized` flag at line 1054 guards
  double-drain.
- **Conversation id storage**: `task.provider_config[agentId].conversationId`
  (migration 34, `migrations.ts:702`). Existing accessors at
  `packages/domains/task/src/shared/types.ts:46-101` (verified):
  `getProviderConversationId(cfg, mode)`,
  `setProviderConversationId(cfg, mode, val)` — passing `val = null`
  clears the id for that mode (this is what v5 wrongly called a
  separate `clearProviderConversationId`; no such helper exists and
  none is added),
  `clearAllConversationIds(cfg)` (clears every mode). **No signature
  changes in v6.**
- **Capture pipeline**: `notify.sh:65-73` extracts `session_id` /
  `conversationId`; `rest-api/agent-hook.ts:217-236`
  (`persistConversationId`) writes via `updateTask`.
- **Hook event taxonomy**: `agent-hook.ts:76-78` confirms `Stop` and
  `SessionEnd` are distinct cases; both map to `'idle'` terminal
  state.
- **Resume template selection**: `pty-manager.ts:769-773` selects
  `resume_command` vs `initial_command` based on
  `existingConversationId`.
- **Renderer resume contract**: `TaskDetailPage.tsx:2984-2985` passes
  `existingConversationId={getConversationIdForMode(task) || undefined}`.
- **Post-spawn agent invocation**: in `postSpawnCommand`
  (`pty-manager.ts:1212-1218` on non-Windows).
- **`onInvalidResume`** chat-path fallback at
  `chat-transport-manager.ts:~780`.
- **Probe step**: `testExecutionContext` (`pty-manager.ts:600-616`)
  probes `tmux curl jq git`. v5 extends to also report tmux version.
- **`installCache`**: per-`(sshExecutable, target)` Promise cache at
  `remote-hook-installer.ts:28`; busted on failure at line 47.
- **Project execution context**: `projects` table column
  `execution_context` (JSON) per
  `packages/domains/projects/src/shared/types.ts:56`. Helper to
  resolve from `projectId` does NOT exist in any
  `packages/shared/transport/src/server/context.ts` (that file is
  13 lines of tRPC type defs); v5 introduces it where it belongs.

---

## Cross-cutting design choices

### CC1. Dedicated tmux socket via `slz-tmux` wrapper

Every SlayZone-emitted tmux command on the remote — from
`transport-spawn`, Step 1 install, Step 2 IPCs, Step 3a probe — goes
through a single wrapper script that ALWAYS passes both `-L slayzone`
AND `-f ~/.tmux/slayzone.conf`. This solves v3's `-f`-flag bug.

#### CC1a. The wrapper script

Step 1 install writes `~/.slayzone/bin/slz-tmux` (mode 0755):

```sh
#!/bin/sh
# Managed by SlayZone. Pins the SlayZone socket and config file on
# every tmux invocation. Edit only via SlayZone.
exec tmux -L slayzone -f "$HOME/.tmux/slayzone.conf" "$@"
```

The wrapper is a fresh `exec` per call, so the flags apply every
invocation (no `-f`-is-startup-only bug).

#### CC1b. Bootstrap discipline (round 4 CRITICAL #4 + #5)

The wrapper file must exist on the remote before ANY SlayZone code
calls it. Two changes vs. v4:

1. **Merge v4 Commit 1 and Commit 2** into a single Commit-A. The
   socket cutover, the inner-script set-option calls, the wrapper
   install, the slayzone.conf write, and the CC1c migration all ship
   together. No deployment window where set-option calls hardcode a
   path that doesn't exist yet.

2. **Step 2 IPC handlers gate on full install presence.** Add helper
   `ensureRemoteWrapper(sshExecutable, target): Promise<void>` that
   shells a probe checking BOTH `[ -x ~/.slayzone/bin/slz-tmux ]` AND
   `[ -r ~/.tmux/slayzone.conf ]`. If either is missing, **invoke the
   full `setupRemoteAgentHooks`** (already idempotent + cached) — not
   a "subset." The wrapper's `tmux -L slayzone -f ~/.tmux/slayzone.conf`
   fatals on a missing config file, so wrapper-without-conf is worse
   than no install. By calling the existing install function we get:
   wrapper + conf + plugin tree + CC1c migration. The cache at
   `remote-hook-installer.ts:28` gates re-run cost; second IPC on
   the same target hits the cached Promise. The user can open the
   Settings panel on a never-spawned target — the install fires on
   first open.

#### CC1c. Migration for existing default-socket `slz-*` sessions

On first connect after Commit-A install (post-wrapper-write), run a
one-shot migration:

1. Probe default socket: `ssh <target> tmux list-sessions -F '#{session_name}' 2>/dev/null`.
2. For each `^slz-` result, attempt to read
   `tmux show-options -t <name> -v -q @slz-task-id` on the default
   socket.
3. **If `@slz-task-id` present** (impossible in practice — see Open Q
   #1, kept for defensive paranoia): kill the session, emit
   `pty.tmux_legacy_session_killed`.
4. **If absent**: surface in Step 2 panel as "Legacy sessions (default
   socket)" — user kills manually. Emit
   `pty.tmux_legacy_session_surfaced`.
5. Write `~/.slayzone/migration-done.v1` so step runs at most once
   per `(target, MIGRATION_VERSION='v1')`. Marker is written **last**
   in `doSetup` (after every other Step 1 step succeeds) so a
   partial-install failure doesn't skip the install but persist the
   migration.

Migration runs even on hosts that never had default-socket sessions
(empty probe → marker writes → no diagnostic noise).

**Rolling upgrade caveat**: if the user runs two SlayZone instances
concurrently against the same remote (e.g. dev + prod build, or
during an upgrade), the new instance's migration will kill default-
socket sessions that the OLD instance's PTYs still hold. The OLD
instance will then see "session not found" on its ssh and the agent
will appear to disconnect. This is unsupported during the Commit A
rollout. Documented limitation; the user should close the old
SlayZone before launching the new one.

### CC2. SlayZone instance id

Persisted at `${userData}/.slayzone-instance-id` (one UUID), survives
`pnpm clean` because userData lives outside the working tree. Created
on first launch if missing. `SLAYZONE_INSTANCE_ID` env var overrides
(used by Playwright; document as dev-only).

Helper `getSlayzoneInstanceId()` in
`packages/apps/app/src/main/instance-id.ts` (NEW file). Exposure to
renderer:

- New main IPC: `ipcMain.handle('instance:getId', () => getSlayzoneInstanceId())`
  in `apps/app/src/main/index.ts`.
- Preload addition in `apps/app/src/preload/index.ts`:
  `instance: { getId: () => ipcRenderer.invoke('instance:getId') }`.
- Types: extend `window.api` interface in the preload typings file.
- Renderer caches first call in module-level `Promise<string>` so
  subsequent renders don't re-IPC.

### CC3. Session tagging

At spawn time, BEFORE the inner script exec's bash:

```sh
cd <workdir>
export SLAYZONE_*=...
~/.slayzone/bin/slz-tmux set-option -t slz-<sessionId> -q @slz-task-id "<taskId>" || true
~/.slayzone/bin/slz-tmux set-option -t slz-<sessionId> -q @slz-tab-id "<tabId>" || true
~/.slayzone/bin/slz-tmux set-option -t slz-<sessionId> -q @slz-instance-id "<instanceId>" || true
~/.slayzone/bin/slz-tmux set-option -t slz-<sessionId> -q @slz-mode "<agentMode>" || true
~/.slayzone/bin/slz-tmux set-option -t slz-<sessionId> -q @slz-created "<iso8601>" || true
exec /bin/bash -i -l
```

Since v5 merges what was v4-Commit-1 and v4-Commit-2 into Commit-A,
the wrapper is guaranteed to exist when these calls fire. No fallback
needed.

The `sessionId === undefined` branch at `transport-spawn.ts:124-126`
runs the inner script bare with no tmux wrap and no set-option calls.

Reading back:

```
~/.slayzone/bin/slz-tmux show-options -t <name> -v -q @slz-task-id 2>/dev/null
```

### CC4. Diagnostics events

- `pty.tmux_persistence_installed` / `pty.tmux_persistence_skipped`
- `pty.tmux_legacy_session_killed` / `pty.tmux_legacy_session_surfaced`
- `pty.tmux_session_killed` / `pty.tmux_session_list_failed`
- `pty.resume_failed` / `pty.resume_fallback_to_fresh`
- `pty.resume_cleared_session_end`
- `pty.kill_cleared_conversation`

### CC5. Best-effort, never blocks spawn

Failures surface as diagnostic events + UI banners, never thrown
exceptions in the spawn path.

### CC6. SSH option discipline

Every one-shot ssh from new code passes:

```
-o BatchMode=yes
-o ConnectTimeout=10
-o ServerAliveInterval=5
-o ServerAliveCountMax=2
-o ControlMaster=no
-o ControlPath=none
```

Existing `runSsh` in `remote-hook-installer.ts:185-209` is updated to
share these options in Commit-A.

### CC7. `waitForShutdown` contract

New helper `waitForShutdown(sessionId, timeoutMs): Promise<{ exitCode: number | null; reason: 'finalized' | 'already-dead' | 'timeout' }>`
in `pty-manager.ts`:

1. **`sessions.get(sessionId) === undefined`** → resolve immediately
   with `{ exitCode: null, reason: 'already-dead' }`.
2. **`session.finalized === true`** → resolve with stored exit code
   and `reason: 'already-dead'`.
3. **Otherwise**: add a waiter to `session.shutdownWaiters`. On
   invoke, resolve `{ exitCode, reason: 'finalized' }` and remove
   self (idempotent — if the Set was already cleared by
   `finalizeSessionExit`, removal is a no-op).
4. **`timeoutMs` elapsed** → resolve
   `{ exitCode: null, reason: 'timeout' }` and detach the waiter.

Tests: each path + double-finalize race + late-added waiter.

Step 2's kill flow uses `waitForShutdown(sessionId, 5_000)` and
proceeds on any non-error resolve.

---

## Step 1 — tmux state persistence

Install wrapper + tpm + tmux-resurrect + tmux-continuum via the
existing `setupRemoteAgentHooks` path.

### Scope additions to `doSetup` in `remote-hook-installer.ts`

1. **Probe `tmux -V` ≥ 2.1** in the existing round-trip with
   curl/jq/git. Also probe util-linux flock:
   ```
   flock -V 2>/dev/null; echo "FLOCK_EXIT=$?"
   ```
   Exit 0 + stdout matching `/^flock from util-linux/` → util-linux.
   Anything else → busybox / missing → mkdir fallback.
   On tmux too old, emit `pty.tmux_persistence_skipped`
   `reason: 'tmux-too-old:<v>'` and skip Step 1 entirely.

2. **Acquire install lock** at `~/.slayzone/install.lock`:
   - util-linux flock present → `flock -w 60 ~/.slayzone/install.lock <cmd>`.
   - else `mkdir ~/.slayzone/install.lock.d` (atomic mkdir; release
     via shell trap).

3. **Clone tpm pinned to `v3.1.0`** with explicit idempotent guard:
   ```
   if [ -d ~/.tmux/plugins/tpm/.git ]; then
     # Already cloned — fetch + checkout in case the user has it
     # at a different branch
     git -C ~/.tmux/plugins/tpm fetch --tags --depth 1 origin v3.1.0
     git -C ~/.tmux/plugins/tpm checkout v3.1.0
   else
     rm -rf ~/.tmux/plugins/tpm
     git clone --branch v3.1.0 --depth 1 \
         https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
   fi
   ```
   On either branch failing, `rm -rf ~/.tmux/plugins/tpm` and emit
   `pty.tmux_persistence_skipped` `reason: 'tpm-clone-failed: <err>'`.
   Same pattern applies to the resurrect + continuum clones in item 4.

4. **Clone resurrect (`v4.0.0`) + continuum (latest main)**.
   Continuum has no stable tags; document re-evaluation point.

5. **Write `~/.tmux/slayzone.conf`**:
   ```
   # SLAYZONE_CONF_VERSION=v1
   # Managed by SlayZone. Edit only via SlayZone.
   set -g @plugin 'tmux-plugins/tpm'
   set -g @plugin 'tmux-plugins/tmux-resurrect'
   set -g @plugin 'tmux-plugins/tmux-continuum'

   set -g @continuum-save-interval '15'
   set -g @resurrect-capture-pane-contents 'on'
   set -g @resurrect-dir '~/.slayzone/tmux-state'

   # Continuum autosave subprocess inherits $TMUX from the running
   # server (started via slz-tmux), so saves stay on the slayzone
   # socket without explicit -L override. See Open Q #2.

   run-shell '~/.tmux/plugins/tpm/tpm'
   ```

6. **Write `~/.slayzone/bin/slz-tmux`** with the CC1a content. mode
   0755.

7. **Do NOT patch the user's `~/.tmux.conf`.**

8. **Install plugins headlessly** via the wrapper, idempotently:
   ```
   # Kill any stale _slz_install session from a previous interrupted
   # install (best-effort, ignore exit).
   ~/.slayzone/bin/slz-tmux kill-session -t _slz_install 2>/dev/null || true
   # -A so a still-living _slz_install attaches rather than failing.
   ~/.slayzone/bin/slz-tmux new-session -A -d -s _slz_install \
       '~/.tmux/plugins/tpm/bin/install_plugins; ~/.slayzone/bin/slz-tmux kill-server'
   ```
   Shell context throughout the pane — `install_plugins` is a shell
   script.

9. **Run CC1c migration.** Marker `~/.slayzone/migration-done.v1`
   written LAST so partial-install failures don't skip subsequent
   retry.

### Cache semantics

Add `::tmuxResilience::v1` suffix to the existing `installCache` key
in `remote-hook-installer.ts:28` so Step 1 has its own cache lifecycle.

### Out of scope

- Auto-uninstall when project deleted.
- Plugin updates after first install (manual: bump pin + `rm -rf` on
  remote).
- `@continuum-restore 'on'` (deferred follow-up — needs per-session
  restore-on-attach with zombie filter).

---

## Step 2 — kill remote tmux sessions from UI

Two surfaces backed by tag-driven lookup (CC3), running through
`terminal/main` IPC.

### 2a. Right-click on terminal tab → "Kill remote session"

1. Item appears only when `project.execution_context.type === 'ssh'`.
2. Click → confirm dialog with task title + warning that conversation
   state is cleared.
3. On confirm:
   - **Clear `provider_config[mode].conversationId`** via
     `setProviderConversationId(task.provider_config, mode, null)` (the
     existing accessor on `task/src/shared/types.ts`). Mode is known
     from the local task record (`task.mode`). Emit
     `pty.kill_cleared_conversation`.
   - Call `killPty(sessionId)`.
   - Await `waitForShutdown(sessionId, 5_000)` (CC7).
   - Issue ssh with CC6 options:
     `~/.slayzone/bin/slz-tmux kill-session -t slz-<sessionId>`.
   - Bust the Step 3a positive-result probe cache for
     `(target, sessionName)`.
   - Emit `pty.tmux_session_killed`.

### 2b. Project Settings → "Remote sessions" panel

Component `RemoteSessionsPanel` in `worktrees/client`. Renders the
project's target at the top.

For each session on the target's slayzone socket:

- Task title (resolved via `@slz-task-id` tag → local DB).
- Tab id (`@slz-tab-id`).
- Owning SlayZone instance (`@slz-instance-id`).
- Mode (`@slz-mode`).
- Attached / detached (`#{?session_attached,1,0}`).
- Created (`@slz-created`).

Plus a "Legacy sessions (default socket)" group from CC1c. Each
legacy row labeled: **"No SlayZone metadata; killing only removes
the tmux session and does not affect any task's stored agent state.
On next open of any task that was previously on this session,
SlayZone will fail to resume once and recover via fresh start."**
(round 4 MAJOR #7 acknowledgment)

#### IPC handlers (in `terminal/main`)

- `tmux:listSessions(projectId): RemoteSessionInfo[]`
  → awaits `ensureRemoteWrapper(sshExecutable, target)` (CC1b), then
  ssh probes:
  `~/.slayzone/bin/slz-tmux list-sessions -F '#{session_name}\t#{?session_attached,1,0}\t#{q:@slz-task-id}\t#{q:@slz-tab-id}\t#{q:@slz-instance-id}\t#{q:@slz-mode}\t#{q:@slz-created}'`.
  Resolve task titles via local DB join, and **filter** to sessions
  whose `@slz-task-id` resolves to a task whose `project_id` matches
  the calling `projectId`. Sessions on the slayzone socket owned by
  OTHER projects on the same target are hidden from this project's
  panel (they appear in their own project's panel). Untagged
  sessions on the slayzone socket are rare in steady state and
  surfaced under a "Unknown SlayZone sessions on this target" group
  with the same legacy-kill semantics. Cached 5s per
  `(target, instanceId, projectId)`.
- The IPC ALSO probes the **default socket** for legacy `slz-*`
  sessions on every call (one extra ssh round-trip, run in
  parallel). This makes "Legacy sessions" surface reliably even if
  the user creates one manually on the default socket post-install
  (not just one-shot at install time).

- `tmux:killSession(projectId, sessionName, mode: AgentMode | null): { ok; message? }`
  → kill flow above. `mode = null` ≡ legacy untagged: kill only,
  no conversation clear.

- `tmux:killAllSessions(projectId, scope: 'this-instance' | 'all'): { ok: number; failed: number }`
  → iterates with concurrency 4.

Non-ssh projects: early-return with `not-ssh` diagnostic event.

#### `resolveProjectExecutionContext`

Re-use the existing helper at
`packages/domains/worktrees/src/main/run-git.ts:84`:
`resolveProjectExecutionContext(db, projectId): GitExecutionContext`.
Already tested at `run-git.test.ts:155-230`; already imported by
`probe-repo.ts`. Returns `null | { type: 'host' } | { type: 'ssh', target, workdir, shell }`.
The terminal IPC imports from `@slayzone/worktrees/main`. This is a
deliberate cross-domain import — the alternative (duplicate helper in
projects/main) would drift. Follow-up cleanup could move the helper
into a shared `@slayzone/projects` module if cross-domain coupling
becomes painful, but not in this PR.

### Edge cases handled

- **Concurrent kill of focused tab**: kill targets the clicked tab's
  sessionId, not the focused one.
- **Stale ControlMaster**: CC6 options.
- **Network partition mid-kill**: CC6 timeouts bound wait ≤ 20s.
  UI shows spinner + optimistic-remove + revert on failure.
- **Same task in two windows**: kill IPC fires once; both windows'
  state listeners catch `pty:exit` via existing mechanism.
- **Legacy untagged kill**: no conversation clear; documented user
  warning in panel; eventual-consistency recovery via 3d fallback.
- **Settings panel opened on never-spawned ssh project**: CC1b's
  `ensureRemoteWrapper` triggers install on first IPC.

---

## Step 3 — agent session resume

When the remote tmux session is gone and the task has a stored
`provider_config[mode].conversationId`, the next spawn uses it via
the existing renderer path. Renderer owns resume policy. v5 makes NO
changes to the conversation-id storage shape — same single
`conversationId` field as today.

### 3a. (REMOVED in v5)

Round 4 MAJOR #6: the 3a probe was diagnostic-only with no consumer.
v5 drops it entirely. Rely on 3d's resume-error fallback as the sole
recovery mechanism — when the agent fails to resume an invalid id,
the marker watcher fires fallback. One round-trip per spawn saved.

If a future feature genuinely needs "is the remote tmux alive"
telemetry, add the probe then with a real consumer.

### 3b. (not applicable in v5)

### 3c. Clear conversation id on clean user exit via `SessionEnd`

Extend `rest-api/agent-hook.ts` to handle `SessionEnd` distinct from
`Stop`. The existing switch at `agent-hook.ts:76-78` already routes
both to `'idle'` terminal state but as separate cases.

- On `SessionEnd` for any `supportsResume: true` adapter, call:
  ```
  updateTask(deps.db, { id: taskId, providerConfig: { [agentId]: { conversationId: null } } })
  ```
  This mirrors the existing `persistConversationId` write at
  `agent-hook.ts:228-231` (just with `null` instead of an id). The
  deep-merge at `ops/shared.ts:632-636` propagates `null` correctly
  and the dual-write at lines 662-665 nulls the legacy column too.
  Emit `pty.resume_cleared_session_end` with `{taskId, agentId}`.
- Adapters without `supportsResume`: no-op.

**`Stop` is NOT touched** — it fires every turn; clearing on Stop
would silently lose every turn-end's resume id (the v2 critical bug).

**Codex `SessionEnd` emission**: verify during Commit-D. If codex
emits no `SessionEnd`, document that codex's `/exit` won't auto-clear
the conversation id; user must explicitly Kill via Step 2 to get the
same effect.

`onHostKillHandler` (`pty-manager.ts:415-421`) continues to set
`lastKilledAt` but does NOT clear `conversationId` — the renderer
already heuristically gates auto-resume on `lastKilledAt`.

### 3d. PTY-side resume failure fallback

**Most of this already ships.** The full pipeline exists end-to-end
for the local-host case and works without modification for ssh PTYs
(same data pipe; same `detectError` invocation):

- `claude-adapter.ts:67-90` `detectError` emits `code: 'SESSION_NOT_FOUND'`
  on `No conversation found with session ID:`.
- `pty-manager.ts:1377-1404` (data-stream path) and
  `pty-manager.ts:1580-1597` via `shouldNotifySessionNotFound`
  (`pty-exit-strategy.ts:20`) both broadcast `pty:session-not-found`.
- `PtyContext.tsx:223-233` propagates to renderer.
- `TaskDetailPage.tsx:1185-1198` (`handleSessionInvalid`) clears the
  id via `setProviderConversationId(task.provider_config, task.terminal_mode, null)`
  → `updateTask` → `window.api.pty.kill(mainSessionId)` → respawn
  fresh on next open.
- `94-session-invalidation.spec.ts:143` is the existing contract
  test.

So 3d's actual remaining work is small:

1. **Add `supportsResume?: boolean` to `TerminalAdapter`** at
   `packages/domains/terminal/src/main/adapters/types.ts:69` and
   set per the capability table below.
2. **Verify the ssh path fires `detectError`** by running an ssh
   variant of `94-session-invalidation.spec.ts` — same broadcasts
   should fire because the data pipe is identical to local. If for
   some reason the ssh path strips/buffers output differently,
   surface as a Commit C blocker; otherwise no code change.
3. **Extend codex + qwen `detectError`** to emit the same
   `SESSION_NOT_FOUND` code on their respective invalid-session
   strings so the same downstream pipeline handles them.
4. **Add the Commit C status pill** showing "Previous conversation
   could not be loaded — started fresh" when
   `pty.resume_fallback_to_fresh` fires.
5. **Emit `pty.resume_failed` + `pty.resume_fallback_to_fresh`**
   diagnostic events at the point where `handleSessionInvalid`
   fires (currently it's silent in diagnostics).

No new watcher. No new clear helper. No new write path.

**User-visible cost** when the conversation id is stale (the rare
case where the user manually moves a task to a new host against the
single-host assumption, OR the agent's rollout file was wiped on the
remote): one spawn attempt that prints the agent's invalid-session
error, ~5 s of marker-watch window, then a fresh spawn. The status
pill from Commit C says "Previous conversation could not be loaded —
started fresh." Acceptable for the documented edge case.

### Adapter capability declaration

`supportsResume` (boolean) and the `detectError` emitting
`SESSION_NOT_FOUND` are the two per-adapter knobs.

| Adapter      | supportsResume | SESSION_NOT_FOUND wiring | Notes |
| ------------ | -------------- | ------------------------ | ----- |
| claude-code  | true           | already emits (`claude-adapter.ts:69`) | `--resume <id>` |
| codex        | true           | extend `detectError` to emit on its invalid-session marker | `codex resume <id>` — verify Open Q #4 |
| qwen-code    | true           | same marker as claude — share regex | Claude-compatible |
| gemini       | false          | n/a                      | Only `--session-id` for new |
| cursor-agent | false          | n/a                      | Default off; verify |
| ccs          | false          | n/a                      | Adapter says no resume |
| antigravity  | false          | n/a                      | Default off; verify |
| opencode     | false          | n/a                      | Default off; verify |
| copilot      | false          | n/a                      | Default off |

---

## Ordering and commit boundaries (v5)

Three commits. None require schema migrations or accessor signature
changes.

### Commit A — Socket cutover + wrapper install + state persistence + tagging + migration

Merges what was v4-Commit-1 and v4-Commit-2 (round 4 CRITICAL #4 fix).

- `transport-spawn.ts`: emit `~/.slayzone/bin/slz-tmux new-session …`
  for the tmux-wrapped branch. Append `set-option @slz-*` calls
  before `exec`.
- `getSlayzoneInstanceId()` helper in
  `apps/app/src/main/instance-id.ts` backed by
  `${userData}/.slayzone-instance-id`. New IPC `instance:getId` +
  preload bridge + types.
- `TerminalAdapter.supportsResume` field added to
  `packages/domains/terminal/src/main/adapters/types.ts:69`
  (no behavior change yet).
- `remote-hook-installer.ts`: extend `doSetup` per Step 1 (probe,
  flock, tpm/resurrect/continuum clone, slayzone.conf, wrapper
  install, headless plugin install, CC1c migration).
- Diagnostics events for install + migration.

### Commit B — Kill IPC + Settings panel + tab context menu

- `terminal/main` IPC: `tmux:listSessions`, `tmux:killSession`,
  `tmux:killAllSessions`.
- `ensureRemoteWrapper` helper for IPC bootstrap on never-spawned
  targets (round 4 CRITICAL #5 fix).
- Import existing `resolveProjectExecutionContext` from
  `@slayzone/worktrees/main/run-git.ts:84` (cross-domain, deliberate).
- `waitForShutdown(sessionId, timeoutMs)` in `pty-manager.ts` with
  CC7 contract + unit tests.
- `RemoteSessionsPanel` component in `worktrees/client`.
- Terminal tab context menu item.
- Kill paths clear `provider_config[mode].conversationId` via the
  existing accessor for tagged sessions; legacy untagged kill is
  kill-only.
- Playwright e2e: mocked-ssh kill flow + legacy-session kill flow.

### Commit C — `SessionEnd` clearing + PTY-side resume-error fallback

- `rest-api/agent-hook.ts` `SessionEnd` handler calls
  `setProviderConversationId(cfg, agentId, null)`.
- Resume-failure detector wired to the existing `detectError`
  `SESSION_NOT_FOUND` code (no new marker pipeline). Codex /
  qwen-code adapters extend `detectError` to emit the same code.
- Status pill on terminal banner: "Resumed from <id>" / "Previous
  conversation could not be loaded — started fresh."

Each commit has its own Playwright e2e where applicable.

---

## Open questions

1. **Are there ANY default-socket `slz-*` sessions with `@slz-task-id`
   set?** Defensive paranoia in CC1c step 3 — in practice this is
   impossible because tagging shipped at the same time as the
   `-L slayzone` cutover. If we never hit this path in QA, drop it in
   a follow-up.
2. **Continuum autosave socket inheritance.** Validate that continuum's
   periodic save subprocess targets the slayzone socket via inherited
   `$TMUX` (not a hardcoded default-socket path inside continuum's
   save script). If continuum hardcodes, patch its invocation in
   slayzone.conf to route through `slz-tmux save`.
3. **Claude `SessionEnd` semantics.** Confirm it fires only on `/exit`
   and not on app-side teardown (which already routes via
   `onHostKillHandler`).
4. **Codex resume semantics.** Does `codex resume <id>` work from a
   fresh pty without a pre-existing rollout file in cwd?
5. **Plugin update workflow.** Bump-pin + `rm -rf` + retry-install is
   manual. Acceptable for v1.
6. **Other-instance session display.** MVP: instance id raw; UX polish
   later.

---

## What v4 said that's removed in v5

- **Multi-target conversation history (`conversationsByTarget`,
  `conversationIdLastTarget`, `conversationIdVersion`, migrate-on-read,
  CC8, CC9)** — entire mechanism dropped because the user confirmed
  tasks live their lifetime on the host they were created on. This
  eliminates round 4's CRITICALs #1, #2, #3 in one stroke.
- **v4 Commit 1 / Commit 2 / Commit 3 / Commit 4 / Commit 5 split** —
  collapsed to Commit A / B / C. The Commit 1/2 merge fixes round 4
  CRITICAL #4 (wrapper bootstrap gap).
- **3a probe** — diagnostic-only with no consumer; dropped per round 4
  MAJOR #6. Saves one ssh RTT per spawn.
- **Accessor signature changes** — none in v6; existing
  `setProviderConversationId(cfg, mode, val)` /
  `getProviderConversationId(cfg, mode)` /
  `clearAllConversationIds(cfg)` signatures preserved. Per-mode clear
  is `setProviderConversationId(cfg, mode, null)` (no new helper).
  Renderer call sites at
  `TaskDetailPage.tsx:1057,1092,1102,1114,1133,1168,1192,1228,1541`
  remain unchanged.
- **`resolveTaskTarget` helper** — not needed without multi-target.
- **`resolveProjectExecutionContext`** — v4 wrongly cited
  `@slayzone/transport`. v5 invented a duplicate at
  `@slayzone/projects/main`. v6 imports the existing helper from
  `@slayzone/worktrees/main/run-git.ts:84` (verified to exist with
  matching semantics).

## What v4 said that's kept in v5

- **`slz-tmux` wrapper** (CC1) — clean fix for v3's `-f`-flag bug.
- **`mode: AgentMode | null` kill IPC signature** — well-considered
  legacy-untagged-kill behavior preserved.
- **`waitForShutdown` contract** (CC7) — explicit 4-path semantics
  with tests.
- **CC3 tag set-option pattern** with explicit `-t slz-<sessionId>`.
- **Step 1 install order** (probe → clone → conf → wrapper → install →
  migration last).
- **`installCache` version suffix** (`::tmuxResilience::v1`).
- **CC6 SSH option discipline** including `ControlMaster=no` +
  `ControlPath=none`.
- **Best-effort principle** (CC5) — failures emit diagnostics, don't
  block spawn.
