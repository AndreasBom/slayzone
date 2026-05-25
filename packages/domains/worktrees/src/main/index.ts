export { registerWorktreeHandlers, resolveCopyBehavior } from './handlers'
export { getGitWatcher, closeGitWatcher } from './git-watcher'
export { resolveProjectExecutionContext } from './run-git'
export {
  removeWorktree,
  createWorktree,
  runWorktreeSetupScript,
  runWorktreeSetupScriptSync,
  getCurrentBranch,
  isGitRepo,
  copyIgnoredFiles,
  getIgnoredFileTree
} from './git-worktree'
export { probeRepo, type ProbeRepoResult } from './probe-repo'
export {
  ensureColors as ensureWorktreeColors,
  getColor as getWorktreeColor,
  getProjectColors as getProjectWorktreeColors,
  ensureProjectColors as ensureProjectWorktreeColors
} from './color-registry'
