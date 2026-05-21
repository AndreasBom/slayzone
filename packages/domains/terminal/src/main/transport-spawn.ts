import { homedir, platform } from 'os'
import { existsSync } from 'fs'
import path from 'path'
import type { ExecutionContext } from '@slayzone/terminal/shared'
import { quoteForShell } from './shell-env'

/**
 * Resolve the ssh executable. node-pty on Windows uses CreateProcessW under
 * the hood and does not always resolve a bare `ssh` against PATH the way
 * cmd.exe does — it fails with the generic "File not found". On Windows we
 * therefore prefer the Microsoft OpenSSH client at
 * `%SystemRoot%\System32\OpenSSH\ssh.exe`, fall back to the Git for Windows
 * port if that's missing, and finally the bare name (so Linux/macOS still
 * use the PATH-resolved binary).
 *
 * Override via `SLAYZONE_SSH_PATH` if you need a specific binary.
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

export interface TransportSpawn {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/**
 * Build a tmux session name from a SlayZone session id. tmux names cannot
 * contain `:` or `.` (both reserved in target syntax). We replace them with
 * `_` so panes whose session id is `${taskId}:${tabId}` stay deterministic
 * across app restarts → free reattach via `tmux new-session -A`.
 */
export function tmuxSessionNameFor(sessionId: string): string {
  return `slz-${sessionId.replace(/[:.]/g, '_')}`
}

/**
 * Wrap a spawn for docker/ssh execution contexts.
 *
 * - host: returns null (caller spawns locally)
 * - docker: `docker exec -it -e KEY=VAL ... -w workdir -- container shell -i -l`
 * - ssh: `ssh -t [-R port:localhost:port] -- target tmux new-session -A -s <name> '<inner>'`
 *
 * SSH always wraps the remote shell in `tmux new-session -A` so sessions
 * survive ssh disconnects and app restarts. Reattach is automatic because the
 * tmux session name is deterministic per `sessionId`. When `sessionId` is not
 * provided, tmux wrapping is skipped (defensive fallback for callers without
 * a stable id; production createPty always supplies one).
 *
 * MCP host: when a reverse port forward is active, remote CLIs see the host
 * MCP server at `localhost:<port>` via `SLAYZONE_MCP_HOST=localhost`.
 */
export function buildTransportSpawn(
  ctx: ExecutionContext | null | undefined,
  cwd: string,
  env: Record<string, string>,
  adapterEnv: Record<string, string>,
  mcpEnv: Record<string, string>,
  sessionId?: string,
  mcpPortOverride?: number
): TransportSpawn | null {
  if (!ctx || ctx.type === 'host') return null

  if (ctx.type === 'docker') {
    const workdir = ctx.workdir || cwd
    const containerShell = ctx.shell || '/bin/bash'
    const dockerArgs = ['exec', '-it']

    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      dockerArgs.push('-e', `${k}=${v}`)
    }
    dockerArgs.push('-e', 'SLAYZONE_MCP_HOST=host.docker.internal')
    dockerArgs.push('-w', workdir, '--', ctx.container, containerShell, '-i', '-l')

    return { file: 'docker', args: dockerArgs, cwd: homedir(), env }
  }

  if (ctx.type === 'ssh') {
    const workdir = ctx.workdir || cwd
    const remoteShell = ctx.shell || '/bin/bash'
    const mcpPort =
      mcpPortOverride ?? ((globalThis as Record<string, unknown>).__mcpPort as number | undefined)

    const sshArgs = ['-t']
    // Use explicit 127.0.0.1 instead of `localhost` so ssh doesn't try the
    // IPv6 ::1 address first on hosts where `localhost` is dual-stack — the
    // SlayZone MCP server binds IPv4 only and a ::1 attempt yields a silent
    // "empty reply" via the tunnel.
    if (mcpPort) sshArgs.push('-R', `${mcpPort}:127.0.0.1:${mcpPort}`)
    sshArgs.push('--', ctx.target)

    const innerParts: string[] = [`cd ${quoteForShell(workdir)}`]
    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      innerParts.push(`export ${k}=${quoteForShell(v)}`)
    }
    if (mcpPort) innerParts.push(`export SLAYZONE_MCP_HOST=localhost`)
    // Prepend ~/.slayzone/bin so the slay-proxy script installed by
    // remote-hook-installer.ts shadows any pre-existing remote `slay` binary.
    // Agent shells inside this tmux session will route every `slay <cmd>` back
    // to the host's real CLI via the reverse-forwarded MCP loopback.
    innerParts.push(`export PATH="$HOME/.slayzone/bin:$PATH"`)
    innerParts.push(`exec ${quoteForShell(remoteShell)} -i -l`)
    const innerScript = innerParts.join(' && ')

    if (sessionId) {
      const tmuxName = tmuxSessionNameFor(sessionId)
      sshArgs.push(`tmux new-session -A -s ${quoteForShell(tmuxName)} ${quoteForShell(innerScript)}`)
    } else {
      sshArgs.push(innerScript)
    }

    return { file: resolveSshExecutable(), args: sshArgs, cwd: homedir(), env }
  }

  return null
}
