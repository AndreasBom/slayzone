/**
 * `probeRepo` — transport-aware "is this project's path a git repo?" check.
 *
 * Replaces the renderer's legacy `git:isGitRepo(path)` call for project-bound
 * detection. Looks up the project's `execution_context` from the DB so the
 * probe runs locally for host projects and over ssh for remote projects.
 *
 * Returns enough metadata for the renderer to render the right state without
 * doing a second IPC round-trip: the resolved working tree path, the
 * execution-context type (so the UI can tag remote projects), and an error
 * string when the probe fails so the Git tab can surface "remote unreachable"
 * vs "not a git repo" distinctly.
 */
import type { Database } from 'better-sqlite3'
import { runGit, resolveProjectExecutionContext } from './run-git'

export interface ProbeRepoResult {
  /** True iff `git rev-parse --is-inside-work-tree` succeeded against the
   *  resolved working tree (local fs for host, remote fs for ssh). */
  isGitRepo: boolean
  /** Working-tree path the probe ran against. Null if the project row or
   *  its `path` column is missing. */
  path: string | null
  /** 'host' for local execution, 'ssh' for remote, 'host' (fallback) when
   *  the row has no `execution_context` set. Useful for the renderer to
   *  show a remote-indicator badge. */
  executionContextType: 'host' | 'ssh'
  /** Populated only when the probe failed transportally (e.g. ssh connect
   *  timeout). For "ran git, got non-zero exit", `isGitRepo` is false and
   *  this stays undefined — that's the "not a repo" case, not an error. */
  error?: string
}

interface ProjectRow {
  path: string | null
}

export async function probeRepo(db: Database, projectId: string): Promise<ProbeRepoResult> {
  let row: ProjectRow | undefined
  try {
    row = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
      | ProjectRow
      | undefined
  } catch (err) {
    return {
      isGitRepo: false,
      path: null,
      executionContextType: 'host',
      error: (err as Error).message
    }
  }

  if (!row || !row.path) {
    return {
      isGitRepo: false,
      path: null,
      executionContextType: 'host'
    }
  }

  const ctx = resolveProjectExecutionContext(db, projectId)
  const executionContextType: 'host' | 'ssh' = ctx?.type === 'ssh' ? 'ssh' : 'host'

  // The cwd we hand to git: for host, the project's local path. For ssh,
  // prefer the project's stored path; the runGit ssh path will pass it via
  // `git -C` against the remote filesystem.
  const cwd = row.path

  try {
    const result = await runGit(ctx, ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 15_000
    })
    if (result.status === 0 && result.stdout.trim() === 'true') {
      return { isGitRepo: true, path: cwd, executionContextType }
    }
    // git exited non-zero (cwd not inside a worktree, or path doesn't exist
    // remotely). That's "not a git repo" — no transport error.
    return { isGitRepo: false, path: cwd, executionContextType }
  } catch (err) {
    // Spawn-level failure (ssh binary missing, connection refused before git
    // ever ran, etc). Surface so the renderer can show "remote unreachable"
    // distinct from "not a git repo".
    return {
      isGitRepo: false,
      path: cwd,
      executionContextType,
      error: (err as Error).message
    }
  }
}
