# Remote-SSH — Full Write-Path & Coverage Plan

Companion to [`REMOTE-SSH-SPEC.md`](./REMOTE-SSH-SPEC.md) and
[`REMOTE-SSH-PLAN.md`](./REMOTE-SSH-PLAN.md). The first round of work
(commits `9d17b4c8 … cfce9d6a`) made the read paths of the Git tab + the
Editor file tree work for ssh projects. This plan covers what is still
host-only and how to finish it.

## Status snapshot

Already migrated (carries `executionContext` end-to-end):

| Surface | Worktree fn | IPC | Renderer |
|---|---|---|---|
| Git tab — repo detection | `probeRepo` | `git:probeRepo` | `useConsolidatedGeneralData`, `ProjectGeneralTab` |
| Git tab — branch / status / remote / ahead-behind | `getCurrentBranch`, `getStatusSummary`, `getRemoteUrl`, `getAheadBehindUpstream`, `listBranches`, `hasUncommittedChanges`, `getRecentCommits` | same `git:*` | `useConsolidatedGeneralData`, `ProjectGeneralTab` |
| Git tab — Changes (diff) | `getWorkingDiff`, `getFileDiff` | same | `git-diff-store`, `GitDiffPanel` |
| Git tab — Commits & Branches | `getCommitDag`, `getResolvedCommitDag` | same | `useBranchGraph`, `BranchesTab` |
| Git tab — watcher | n/a (graceful no-op on ssh) | `git:watch-start`, `git:watch-stop` | `git-diff-store` (poll fallback) |
| Editor — file tree | `sshReadDir` | `fs:readDir` | `EditorFileTree` |
| Editor — file open | `sshReadFile` | `fs:readFile` | `useFileEditor` |

## What still falls back to local fs / spawn

### A. Git writes (Git tab actions all blow up against ssh today)

| API | Used by | Effort |
|---|---|---|
| `init` | "Initialize git" button in `ProjectGeneralTab`, `useConsolidatedGeneralData` | XS |
| `checkoutBranch` | `ProjectGeneralTab` branch switcher | XS |
| `createBranch` | `ProjectGeneralTab` new-branch flow | XS |
| `stageFile` / `unstageFile` / `discardFile` | `GitDiffPanel` file actions, `ConflictFileView` | S |
| `stageAll` / `unstageAll` | `GitDiffPanel`, `UnifiedGitPanel` | XS |
| `commitFiles` | `GitDiffPanel`, `UnifiedGitPanel` | XS |
| `fetch` / `push` / `pull` | `RemoteSection`, `BranchesTab`, `useConsolidatedGeneralData` | S |
| `mergeIntoParent` / `mergeWithAI` / `abortMerge` | `useConsolidatedGeneralData`, `UnifiedGitPanel` | M (writes + tmp files) |
| `getMergeContext` / `getConflictedFiles` / `getConflictContent` / `writeResolvedFile` | `UnifiedGitPanel`, `ConflictFileView` | M |
| `analyzeConflict` | `ConflictFileView` | M (mergeAI binary on remote? defer) |
| `continueRebase` / `abortRebase` / `skipRebaseCommit` | `UnifiedGitPanel` | XS |
| `rebaseOnto` / `mergeFrom` | `useConsolidatedGeneralData` | S |
| `createWorktree` | `useConsolidatedGeneralData`, `CreateWorktreeDialog`, `WorktreesTab` | L (touches fs setup script + copy semantics — needs careful design) |
| `removeWorktree` | `useConsolidatedGeneralData`, `WorktreesTab` | S |
| `detectWorktrees` | `WorktreesTab`, branch-switcher | S |
| `isDirty` | `WorktreesTab` | XS |
| `revealInFinder` | `WorktreesTab` | n/a (always local — disable for ssh) |
| `copyIgnoredFiles` | `useConsolidatedGeneralData` (worktree creation) | L (fs heavy) |
| `resolveCopyBehavior` | same | S |

### B. Git reads still threading only `path`

| API | Used by | Effort |
|---|---|---|
| `getResolvedForkGraph` / `getResolvedUpstreamGraph` | task-General fork graph in `useConsolidatedGeneralData` | S |
| `getResolvedRecentCommits` | (currently unused but exported) | XS |
| `getDiffStats` | Changes-stats summary in task / project | XS |
| `getMergeBase` / `getCommitsSince` / `getCommitsBeforeRef` | internal to fork graph + DAG | XS (inner) |
| `listBranchesDetailed` (IPC) | branch popover in `WorktreesTab` | XS |
| `getCommitDag` (IPC) | direct callers (if any) | XS |
| `listStashes` / `getStashDiff` / `createStash` / `applyStash` / `popStash` / `dropStash` / `branchFromStash` | `StashTab` | S |
| `resolveChildBranches` | `BranchesTab` | XS |
| `detectChildRepos` / `listProjectRepos` / `isGitRepo` (the path-based one) | repo detection on project create | M (semantics differ on ssh) |

### C. Editor file-editor writes

| IPC | Used by | Effort |
|---|---|---|
| `fs:writeFile` | `useFileEditor` save | S |
| `fs:createFile` | `EditorFileTree` new-file | XS |
| `fs:createDir` | `EditorFileTree` new-folder | XS |
| `fs:rename` | rename in file tree | XS |
| `fs:delete` | delete in file tree | XS |
| `fs:copy` | duplicate in file tree | S |
| `fs:copyIn` | external file paste | L (needs scp or stream upload) |
| `fs:watch` / `fs:unwatch` | live external change detection | M (inotify-over-ssh stream OR poll) |
| `fs:gitStatus` | `EditorFileTree` M/A/?-badges | S |
| `fs:searchFiles` | code search panel | M (run via `grep -r` over ssh) |
| `fs:listAllFiles` | command-K file picker | S |
| `fs:showInFinder` | open in OS file manager | n/a (always local — disable for ssh) |

### D. GitHub / `gh` CLI

All of these spawn `gh` locally today. Two options:
- **Defer** — leave host-only; works for any local PR workflow regardless of where the repo lives. Slightly inconsistent UX for users whose repo is purely on remote.
- **Migrate** — route via ssh + remote `gh`. Requires `gh` on remote and auth set up there.

APIs in scope: `checkGhInstalled`, `listOpenPrs`, `getPrByUrl`,
`getPrComments`, `addPrComment`, `editPrComment`, `mergePr`, `getPrDiff`,
`createPr`, `getGhUser`. **Decision: defer until a user asks.**

### E. Phase 4 — Artifacts from remote agents

Untouched. See `REMOTE-SSH-PLAN.md` Phase 4 — needs a `/api/artifact/upload`
endpoint + a `slay artifact upload` subcommand routed via the slay-proxy.

## The migration pattern (already proven for read APIs)

For every API in Section A or B, the migration is the same five-line dance:

1. **Worktree fn:** add `executionContext?: GitExecutionContext` as the
   trailing param and pass it into every internal `execGit({ cwd, executionContext })`.
2. **IPC handler:** accept an optional `projectId` trailing arg and call
   `ctxFromProjectId(db, projectId)` to derive the context.
3. **Preload bridge:** accept + forward the `projectId`.
4. **`window.api.git` type in `packages/shared/types/src/api.ts`:** add the
   `projectId?: string` parameter.
5. **Renderer callsite:** thread the `projectId`. Source is one of:
   - `task.project_id` (TaskDetailPage subtree)
   - `projectId` prop passed down by `UnifiedGitPanel` / `ProjectGeneralTab`
   - `selectedProjectId` (home panel in `App.tsx`)

Each migration takes ~5 minutes once the pattern is internalised. Bundle
them into thematic commits so reviewer cognitive load stays low.

For file-editor writes the pattern is identical but routes through
`sshWriteFile` / `sshCreateFile` etc. — those don't exist yet; add them
to `packages/domains/file-editor/src/main/ssh-fs.ts` first, then mirror
the read-path threading in handlers.

## Suggested order of attack

Highest user value per LOC first. Each batch is a single coherent commit.

### Batch 1 — Stage / commit / discard (`~1.5h`)
Lets the user actually USE the Git tab to commit work to remote.
- `init`, `checkoutBranch`, `createBranch`
- `stageFile`, `unstageFile`, `discardFile`, `stageAll`, `unstageAll`
- `commitFiles`

### Batch 2 — Push / pull / fetch (`~1h`)
After commit, the user can sync.
- `fetch`, `push`, `pull`
- Renderer wiring in `RemoteSection`, `useConsolidatedGeneralData`,
  `BranchesTab`.

### Batch 3 — Fork graph + diff stats (`~1h`)
Cleans up the remaining task-tab metrics.
- `getResolvedForkGraph`, `getResolvedUpstreamGraph`
- `getDiffStats`, `getMergeBase`, `getCommitsSince`, `getCommitsBeforeRef`
- `getResolvedRecentCommits` (cheap include)

### Batch 4 — Stashes + child branches + detailed branches (`~1h`)
- `listStashes`, `createStash`, `applyStash`, `popStash`, `dropStash`,
  `branchFromStash`, `getStashDiff`
- `resolveChildBranches`
- `listBranchesDetailed`

### Batch 5 — File-editor writes (`~2h`)
Lets the editor save files back to remote.
- Implement `sshWriteFile`, `sshCreateFile`, `sshCreateDir`, `sshRename`,
  `sshDelete`, `sshCopy` in `ssh-fs.ts`. Use POSIX-safe quoting; `tee`
  via `ssh stdin` for writes, `mkdir -p` / `mv` / `rm -rf` / `cp -R` for
  the rest.
- Migrate IPC handlers (`fs:writeFile`, `fs:createFile`, `fs:createDir`,
  `fs:rename`, `fs:delete`, `fs:copy`) to use the abstraction.
- Renderer: thread `projectId` from `EditorFileTree` / `useFileEditor` —
  signatures already accept it for the read path; just plumb through.
- Skip `fs:copyIn` (requires scp/stream upload — design first).

### Batch 6 — `fs:gitStatus` over ssh (`~30min`)
Make M/A/?-badges work in the file tree.
- Replace the local `spawn('git', ['status', '--porcelain'], { cwd })`
  in `handlers.ts` with `runGit` so the existing parser keeps working.
- Renderer: `EditorFileTree.tsx` currently calls `fs.gitStatus(rootPath)`
  — add `projectId` arg + preload forwarding.

### Batch 7 — Merge / rebase / conflict resolution (`~3h`)
Unlocks merging branches on remote worktrees.
- Worktree fns: `mergeIntoParent`, `mergeWithAI`, `abortMerge`,
  `getMergeContext`, `getConflictedFiles`, `getConflictContent`,
  `writeResolvedFile`, `continueRebase`, `abortRebase`,
  `skipRebaseCommit`, `rebaseOnto`, `mergeFrom`.
- Defer `analyzeConflict` (mergeAI binary path) — leave host-only with a
  banner toast when ssh project requests it.

### Batch 8 — Worktree management (`~half-day`)
Needs design — the current `createWorktree` is filesystem-heavy
(setup-script, copyIgnoredFiles). Two reasonable paths:
- **Naive port:** every step over ssh (slow but works). Acceptable for
  weekly worktree creation.
- **Hybrid:** spawn `git worktree add` on remote, but keep the
  copy-ignored-files dance host-side and scp the diff. Complex.

Pick during the batch. Includes `createWorktree`, `removeWorktree`,
`detectWorktrees`, `isDirty`, `revealInFinder` (disable for ssh),
`copyIgnoredFiles`, `resolveCopyBehavior`.

### Batch 9 — Live remote watcher (`~half-day`)
Replace the current poll-only fallback with a real change stream.
Recommended approach: `ssh -- target "inotifywait -m -r --exclude
'...' /path"` parsed line-by-line in the main process; emit
`git:diff-changed` on relevant paths.

### Batch 10 — Artifacts (Phase 4 from the original plan)
Independent — schedule whenever a user needs it.

## Acceptance criteria per batch

For each batch the merged commit must demonstrate:

- All affected APIs pass `executionContext` end-to-end (verified by a
  quick grep — every IPC handler with a path arg also takes `projectId`
  in its new signature).
- A live test against the user's `carelogic-dev` host shows the action
  succeeds and the renderer reflects the new state.
- Existing host-mode behaviour for the same APIs is byte-identical
  (verified by running an existing host-only task end-to-end).
- The dev log shows the resolved ssh command in `git.command` diagnostic
  events when the action runs against an ssh project — never a local
  fallback.

## Risks + open calls

- **`createWorktree` semantics** — host-mode does a lot of post-spawn
  work (setup script, ignored-file copy, submodule init). All of that
  needs ssh equivalents OR a "remote worktrees use plain `git worktree
  add` + no copy" mode the user opts into. Talk through this before
  starting Batch 8.
- **`analyzeConflict` / `mergeWithAI`** — runs an AI subprocess. Almost
  certainly should stay host-only and ask the user to manually resolve
  on remote, OR copy the conflict files locally for AI then push the
  resolution back. Defer until Batch 7 is shipped.
- **PR (`gh`) APIs** — punted in Section D. Revisit if a user reports.
- **SSH connection reuse** — every IPC currently opens a fresh ssh
  connection (~150 ms handshake). With ControlMaster + ControlPersist
  this could drop to <5 ms. Defer until perf is measured under load.
