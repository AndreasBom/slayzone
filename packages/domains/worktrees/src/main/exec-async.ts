import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { platform } from 'os'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { DiagnosticSource } from '@slayzone/diagnostics/shared'
import { runGit, type GitExecutionContext } from './run-git'

/**
 * Node's child_process.spawn does PATH lookup on Windows but does NOT honour
 * PATHEXT — so `spawn('git', ...)` fails with ENOENT when the binary is
 * `git.exe`. Resolve to an absolute path once on first use so subsequent
 * spawns work without `shell: true` (which would force us to do our own
 * cmd.exe arg quoting).
 *
 * Overridable via SLAYZONE_GIT_PATH for power users / CI.
 */
let cachedGitPath: string | null = null
function resolveGitExecutable(): string {
  if (cachedGitPath) return cachedGitPath
  const override = process.env.SLAYZONE_GIT_PATH
  if (override && existsSync(override)) {
    cachedGitPath = override
    return cachedGitPath
  }
  if (platform() !== 'win32') {
    cachedGitPath = 'git'
    return cachedGitPath
  }
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe') : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'mingw64', 'bin', 'git.exe')
      : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)']!, 'Git', 'cmd', 'git.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')
      : null
  ].filter((c): c is string => !!c)
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedGitPath = candidate
      return cachedGitPath
    }
  }
  // Fall back to the bare name — better an ENOENT we already have than
  // refusing to spawn. Tests that mock spawn can also pass.
  cachedGitPath = 'git'
  return cachedGitPath
}

export function trimOutput(value: unknown, maxLength = 1200): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...[trimmed:${normalized.length - maxLength}]`
}

export interface ExecResult {
  stdout: string
  stderr: string
  status: number | null
}

/** Async subprocess execution — won't block the main process. */
export function execAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; source?: DiagnosticSource } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Resolve `git` to its absolute path on Windows so the spawn doesn't ENOENT
    // (PATH lookup is honoured by child_process but PATHEXT is not). Bare
    // `git` works on macOS/Linux. Callers using other commands (docker, ssh)
    // pass the absolute path themselves.
    const effectiveCommand = command === 'git' ? resolveGitExecutable() : command
    const label = `${command} ${args.join(' ')}`
    const source = opts.source ?? 'git'
    const startedAt = Date.now()
    const child = spawn(effectiveCommand, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.on('data', (data: Buffer) => stdout.push(data.toString()))
    child.stderr.on('data', (data: Buffer) => stderr.push(data.toString()))

    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
      }, opts.timeout)
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      const stdoutStr = stdout.join('')
      const stderrStr = stderr.join('')

      recordDiagnosticEvent({
        level: code === 0 ? 'info' : 'error',
        source,
        event: code === 0 ? `${source}.command` : `${source}.command_failed`,
        message: code === 0 ? label : stderrStr.trim() || `command failed: ${label}`,
        payload: {
          command: label,
          cwd: opts.cwd,
          durationMs,
          success: code === 0,
          exitCode: code,
          ...(code !== 0 && { stderr: trimOutput(stderrStr), stdout: trimOutput(stdoutStr) })
        }
      })

      resolve({ stdout: stdoutStr, stderr: stderrStr, status: code })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, status: 1 })
    })
  })
}

/**
 * Async git execution — rejects on non-zero exit.
 *
 * Routes through `runGit` so the same callsite transparently supports remote
 * SSH execution when `options.executionContext.type === 'ssh'` is provided.
 * Existing callers that pass only `{ cwd }` continue to run git locally
 * (host context), so this consolidation is a no-op for the legacy path.
 */
export function execGit(
  args: string[],
  options: { cwd: string; executionContext?: GitExecutionContext }
): Promise<string> {
  return runGit(options.executionContext ?? null, args, { cwd: options.cwd }).then((result) => {
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
  })
}

/** Like execGit, but appends -z for NUL-delimited output and returns a parsed filename array. */
export function execGitFileList(
  args: string[],
  options: { cwd: string; executionContext?: GitExecutionContext }
): Promise<string[]> {
  return execGit([...args, '-z'], options).then((out) => out.split('\0').filter(Boolean))
}
