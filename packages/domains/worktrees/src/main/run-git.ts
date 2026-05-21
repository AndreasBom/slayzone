/**
 * Transport-aware `git` runner.
 *
 * For projects with `execution_context.type === 'host'` (or no context, the
 * default), git commands run locally — identical behaviour to the legacy
 * `execGit({ cwd })` path. For `execution_context.type === 'ssh'`, the same
 * args are forwarded to the remote host via the `ssh` binary, with the cwd
 * passed through `git -C` so the call works against the remote working tree.
 *
 * Step 1 of REMOTE-SSH-PLAN Phase 2: this introduces the adapter without
 * migrating any existing consumers — they continue to call the legacy
 * `execGit` helper. Subsequent commits will migrate git-watcher, branch-ops,
 * diff, and log to this entry point so the Git tab works against a remote
 * working tree.
 */
import { existsSync } from 'fs'
import path from 'path'
import { platform } from 'os'
import type { Database } from 'better-sqlite3'
import { execAsync, type ExecResult } from './exec-async'

export interface ExecutionContextSsh {
  type: 'ssh'
  target: string
  workdir?: string | null
  shell?: string | null
}

export interface ExecutionContextHost {
  type: 'host'
}

export type GitExecutionContext = ExecutionContextHost | ExecutionContextSsh | null | undefined

export interface RunGitOptions {
  /** Working directory on the *target* filesystem. Local fs for host, remote
   *  fs for ssh. Falls back to `executionContext.workdir` (ssh-only). */
  cwd?: string
  /** Subprocess timeout in milliseconds. */
  timeout?: number
}

/**
 * POSIX shell single-quote. Always single-quote: cheaper than escaping `$`,
 * `` ` ``, `"`, etc. Embedded single quotes become `'\''`.
 */
export function posixQuote(arg: string): string {
  if (arg.length === 0) return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Resolve the local `ssh` executable. Mirrors transport-spawn's resolver so
 * the same Windows OpenSSH preference applies to git-over-ssh calls.
 *
 * Override via `SLAYZONE_SSH_PATH` for tests / custom installs.
 */
export function resolveSshExecutable(): string {
  const override = process.env.SLAYZONE_SSH_PATH
  if (override && existsSync(override)) return override
  if (platform() !== 'win32') return 'ssh'
  const candidates = [
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe')
      : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'ssh.exe')
      : null
  ].filter((c): c is string => !!c)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'ssh'
}

/**
 * Look up a project's `execution_context` by id. Returns `null` for host /
 * missing / corrupt rows — callers should treat all of those as "run locally".
 *
 * Safe to call inside the legacy execGit path: a null result keeps current
 * behaviour. Never throws — corrupted JSON in the DB logs and degrades to
 * host execution rather than refusing a git operation.
 */
export function resolveProjectExecutionContext(
  db: Database,
  projectId: string
): GitExecutionContext {
  let row: { execution_context: unknown } | undefined
  try {
    row = db
      .prepare('SELECT execution_context FROM projects WHERE id = ?')
      .get(projectId) as { execution_context: unknown } | undefined
  } catch {
    return null
  }
  if (!row || row.execution_context == null) return null
  if (typeof row.execution_context !== 'string') return null
  try {
    const parsed = JSON.parse(row.execution_context)
    if (parsed == null || typeof parsed !== 'object') return null
    const type = (parsed as { type?: unknown }).type
    if (type === 'host') return { type: 'host' }
    if (type === 'ssh') {
      const target = (parsed as { target?: unknown }).target
      if (typeof target !== 'string' || target.length === 0) return null
      const workdir = (parsed as { workdir?: unknown }).workdir
      const shell = (parsed as { shell?: unknown }).shell
      return {
        type: 'ssh',
        target,
        workdir: typeof workdir === 'string' ? workdir : null,
        shell: typeof shell === 'string' ? shell : null
      }
    }
    return null
  } catch {
    return null
  }
}

export interface GitCommand {
  file: string
  args: string[]
  /** Local fs cwd for the spawned process. Always undefined for ssh — the
   *  remote cwd is conveyed via `git -C` inside the wrapped invocation. */
  cwd?: string
}

/**
 * Pure: build the spawn command for a `git` invocation in a given execution
 * context. Extracted so tests can assert on the argv shape without going
 * through child_process.
 *
 * - host (or null context) → `git <args>`, cwd as given.
 * - ssh → `ssh -- <target> git -C <cwd> <args>` with POSIX-quoted args.
 */
export function buildGitCommand(
  context: GitExecutionContext,
  args: string[],
  opts: { cwd?: string } = {}
): GitCommand {
  if (!context || context.type === 'host') {
    return { file: 'git', args: [...args], cwd: opts.cwd }
  }

  // ssh path: build a single remote shell argument so OpenSSH's own arg
  // concatenation doesn't have to know about quoting. Using `git -C <cwd>`
  // instead of `cd && git` so a missing remote dir surfaces as git's own
  // exit code rather than a shell error.
  const remoteCwd = opts.cwd ?? context.workdir ?? null
  const remoteCmdParts = ['git']
  if (remoteCwd) {
    remoteCmdParts.push('-C', posixQuote(remoteCwd))
  }
  for (const a of args) remoteCmdParts.push(posixQuote(a))
  const remoteCmd = remoteCmdParts.join(' ')

  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '--',
    context.target,
    remoteCmd
  ]
  // DO NOT pass opts.cwd through to the local spawn — for ssh transport that
  // value is a REMOTE path and trying to chdir to it locally fails ENOENT
  // before ssh ever runs (UV_ENOENT, exit -4058). The remote cwd is conveyed
  // exclusively via `git -C` inside the wrapped invocation.
  return { file: resolveSshExecutable(), args: sshArgs, cwd: undefined }
}

/**
 * Run a `git` invocation against either the local fs or a remote ssh host.
 *
 * Returns the raw `ExecResult` so callers can inspect non-zero exit codes
 * the way `execAsync` already exposes them. For "throw on non-zero" callers,
 * wrap with `runGitOrThrow` (defined below).
 */
export function runGit(
  context: GitExecutionContext,
  args: string[],
  opts: RunGitOptions = {}
): Promise<ExecResult> {
  const cmd = buildGitCommand(context, args, { cwd: opts.cwd })
  return execAsync(cmd.file, cmd.args, {
    cwd: cmd.cwd,
    timeout: opts.timeout,
    source: 'git'
  })
}

/**
 * Convenience: run `git` and throw on non-zero exit, returning trimmed
 * stdout. Mirrors the contract of the legacy `execGit` helper so consumers
 * migrating off the old API don't have to relearn error handling.
 */
export async function runGitOrThrow(
  context: GitExecutionContext,
  args: string[],
  opts: RunGitOptions = {}
): Promise<string> {
  const result = await runGit(context, args, opts)
  if (result.status !== 0) {
    const errMsg = result.stderr.trim() || `git command failed: git ${args.join(' ')}`
    const error = new Error(errMsg) as Error & {
      status: number | null
      stderr: string
      stdout: string
    }
    error.status = result.status
    error.stderr = result.stderr
    error.stdout = result.stdout
    throw error
  }
  return result.stdout
}
