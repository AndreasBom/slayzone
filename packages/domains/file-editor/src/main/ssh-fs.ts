/**
 * Minimal SSH-backed filesystem for the Editor's file panel.
 *
 * Step 1 of REMOTE-SSH-PLAN Phase 3: cover the two operations the file tree
 * actually blocks on (`list(dir)` + `readFile(abs)`). Writes, watch, search,
 * and copy stay local-only for now — they land in follow-up commits.
 *
 * Why a tiny POSIX-oriented module instead of reusing transport-spawn? The
 * Editor talks pure abs-paths; transport-spawn is intentionally tmux-wrapped
 * for interactive PTY use. Keep the file-editor's network model simple: one
 * ssh round trip per call, no session re-use, no tmux.
 *
 * Path safety: we don't try to enforce the host's "stay below rootPath" rule
 * by `path.resolve` (it would mis-interpret POSIX paths on Windows). Instead
 * we normalize forward-slash relative paths and reject `..` segments before
 * joining onto the remote root. Equivalent guarantee, host-platform-agnostic.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { platform } from 'node:os'
import type { DirEntry, ReadFileResult } from '../shared'

/**
 * Resolve the local `ssh` executable. Duplicated from worktrees/run-git to
 * avoid a cross-domain dep just for one helper. Honours SLAYZONE_SSH_PATH
 * override and prefers Microsoft OpenSSH on Windows.
 */
function resolveSshExecutable(): string {
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

const SSH_DEFAULT_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
const SPAWN_TIMEOUT_MS = 30_000
const MAX_FILE_SIZE = 1 * 1024 * 1024
const FORCE_MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * POSIX-only path joiner. Rejects traversal via `..`. Treats `dirPath` as
 * relative to `rootPath`. Always emits forward slashes.
 */
export function joinRemotePath(rootPath: string, dirPath: string): string {
  if (!dirPath) return rootPath
  const normalized = dirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (normalized.length === 0) return rootPath
  const parts = normalized.split('/')
  for (const p of parts) {
    if (p === '..' || p === '.') {
      throw new Error(`Path traversal denied: ${dirPath}`)
    }
  }
  const trimmedRoot = rootPath.replace(/\/+$/, '')
  return `${trimmedRoot}/${parts.join('/')}`
}

/**
 * POSIX shell single-quote (mirrors the worktrees/run-git helper, copied
 * here to avoid a cross-domain import for one ~5-line helper).
 */
function posixQuote(arg: string): string {
  if (arg.length === 0) return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

interface SshResult {
  stdout: Buffer
  stderr: string
  code: number | null
}

function runSsh(target: string, remoteCmd: string): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const sshArgs = [...SSH_DEFAULT_ARGS, '--', target, remoteCmd]
    const child = spawn(resolveSshExecutable(), sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b))
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, SPAWN_TIMEOUT_MS)
    child.once('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.once('exit', (code) => {
      clearTimeout(killTimer)
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code })
    })
  })
}

/**
 * Remote `readdir` via `find -mindepth 1 -maxdepth 1 -printf '%f\t%y\n'`.
 * Robust against names with spaces (NUL-delim would be cleaner but stat -c
 * with %n isn't NUL-friendly across all coreutils versions). Symlinks
 * surface as 'l' which we resolve to file/dir via a second `find -L` pass.
 */
export async function sshReadDir(
  target: string,
  remoteRoot: string,
  dirPath: string
): Promise<DirEntry[]> {
  const abs = joinRemotePath(remoteRoot, dirPath)
  // %y is one char: d/f/l/etc. Tab separator survives most names; we reject
  // names containing a literal tab to avoid corrupt parsing.
  const cmd = `find ${posixQuote(abs)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n' 2>/dev/null || true`
  const { stdout, code } = await runSsh(target, cmd)
  if (code !== 0 && code !== null) {
    // find returns 1 if the dir is missing; surface as empty so the renderer
    // can show "folder gone" without an IPC error.
    return []
  }
  const lines = stdout.toString('utf8').split('\n').filter(Boolean)
  const entries: DirEntry[] = []
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const name = line.slice(0, tab)
    const kind = line.slice(tab + 1).trim()
    if (name === '.' || name === '..' || name === '.git' || name === '.DS_Store') continue
    if (name.includes('\t')) continue
    const relPath = dirPath ? `${dirPath}/${name}` : name
    if (kind === 'd') {
      entries.push({ name, path: relPath, type: 'directory' })
    } else if (kind === 'f') {
      entries.push({ name, path: relPath, type: 'file' })
    } else if (kind === 'l') {
      // Symlink — resolve via a follow-symlink stat. Best-effort: if the
      // resolution fails (dangling link, permission), drop the entry.
      try {
        const followCmd = `find -L ${posixQuote(abs + '/' + name)} -maxdepth 0 -printf '%y\\n' 2>/dev/null || true`
        const follow = await runSsh(target, followCmd)
        const resolved = follow.stdout.toString('utf8').trim()
        if (resolved === 'd') {
          entries.push({ name, path: relPath, type: 'directory', isSymlink: true })
        } else if (resolved === 'f') {
          entries.push({ name, path: relPath, type: 'file', isSymlink: true })
        }
      } catch {
        /* skip dangling */
      }
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

/**
 * Remote file read. First stats the file for size, refuses oversize without
 * the `force` flag, then `cat`s the bytes. Two round trips on the warm path —
 * acceptable cost for the file panel's lazy load behaviour.
 */
export async function sshReadFile(
  target: string,
  remoteRoot: string,
  filePath: string,
  force?: boolean
): Promise<ReadFileResult> {
  const abs = joinRemotePath(remoteRoot, filePath)
  // stat varies between BSD and GNU. Use `wc -c < file` which is portable.
  const sizeCmd = `wc -c < ${posixQuote(abs)} 2>/dev/null || echo -1`
  const sizeResult = await runSsh(target, sizeCmd)
  const size = parseInt(sizeResult.stdout.toString('utf8').trim(), 10)
  if (Number.isNaN(size) || size < 0) {
    throw new Error(`remote stat failed: ${sizeResult.stderr.trim() || 'unknown'}`)
  }
  if (size > FORCE_MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: size }
  }
  if (!force && size > MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: size }
  }
  const readCmd = `cat ${posixQuote(abs)}`
  const readResult = await runSsh(target, readCmd)
  if (readResult.code !== 0) {
    throw new Error(`remote read failed: ${readResult.stderr.trim() || 'unknown'}`)
  }
  return { content: readResult.stdout.toString('utf8') }
}
