/**
 * Install SlayZone agent lifecycle hooks on a remote SSH host so Claude Code
 * (and other hook-driven agents) can POST lifecycle events back to the local
 * SlayZone app over the reverse-forwarded MCP loopback.
 *
 * Idempotent + concurrency-safe per target: the first call for a given
 * target's promise is cached and shared so concurrent agent spawns don't
 * race to write the same files.
 *
 * Files written on remote:
 *   ~/.slayzone/hooks/notify.sh    (mode 0755)
 *   ~/.claude/settings.json        (merged, preserves user-defined entries)
 *
 * Failures bubble up so the caller can decide whether to block the spawn or
 * proceed without hook plumbing (and accept degraded status reporting).
 */
import { spawn } from 'child_process'
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import notifyScriptSource from '@slayzone/hooks/notify.sh?raw'
import { CLAUDE_HOOK_EVENTS, isManagedSlayzoneHook } from './claude-hook-installer'

const MARKER_KEY = '_slayzoneManaged'
const TOOL_MATCHED_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'Notification'])

const installCache = new Map<string, Promise<void>>()

/**
 * Bust the cache for a target — call this from settings UI when the user
 * edits hook installation manually or changes the host config.
 */
export function clearRemoteHookCache(target?: string): void {
  if (target) installCache.delete(target)
  else installCache.clear()
}

export function setupRemoteAgentHooks(opts: {
  sshExecutable: string
  target: string
}): Promise<void> {
  const key = `${opts.sshExecutable}::${opts.target}`
  let p = installCache.get(key)
  if (p) return p
  p = doSetup(opts).catch((err) => {
    installCache.delete(key) // retry on next spawn
    throw err
  })
  installCache.set(key, p)
  return p
}

async function doSetup(opts: { sshExecutable: string; target: string }): Promise<void> {
  const { sshExecutable, target } = opts

  // 1. Probe remote $HOME + curl + tmux (sanity check). Single round trip.
  const probe = await runSsh(sshExecutable, target, [], 'printf "%s\\n" "$HOME"; command -v curl >/dev/null 2>&1 && echo CURL_OK || echo CURL_MISSING')
  const probeLines = probe.trim().split(/\r?\n/)
  const remoteHome = probeLines[0]?.trim()
  const curlStatus = probeLines[1]?.trim()
  if (!remoteHome) throw new Error(`remote $HOME empty for ${target}`)
  if (curlStatus !== 'CURL_OK') {
    throw new Error(
      `remote ${target} is missing curl — install it (apt install curl / dnf install curl) so notify.sh can post hook events`
    )
  }

  // 2. Write notify.sh with mode 0755.
  const notifyScript =
    typeof notifyScriptSource === 'string' ? notifyScriptSource : String(notifyScriptSource)
  // Normalize line endings (Vite ?raw on Windows might bundle CRLF; remote
  // /bin/sh chokes on CR in the shebang line).
  const notifyScriptLf = notifyScript.replace(/\r\n/g, '\n')
  await runSshStdin(
    sshExecutable,
    target,
    'mkdir -p "$HOME/.slayzone/hooks" && cat > "$HOME/.slayzone/hooks/notify.sh" && chmod 0755 "$HOME/.slayzone/hooks/notify.sh"',
    notifyScriptLf
  )

  // 3. Read existing settings.json, merge managed entries, write back.
  const notifyPathOnRemote = `${remoteHome}/.slayzone/hooks/notify.sh`
  const existingRaw = await runSsh(
    sshExecutable,
    target,
    [],
    'cat "$HOME/.claude/settings.json" 2>/dev/null || true'
  )
  let settings: Record<string, unknown> = {}
  if (existingRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(existingRaw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed JSON: refuse to overwrite. Throw so caller surfaces.
      throw new Error(
        `remote ${target}: ~/.claude/settings.json is not valid JSON — refusing to overwrite`
      )
    }
  }

  const hooks =
    (settings.hooks as Record<string, ClaudeHookEntry[]> | undefined) ??
    ({} as Record<string, ClaudeHookEntry[]>)
  for (const event of CLAUDE_HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    const filtered: ClaudeHookEntry[] = []
    for (const entry of list) {
      if (entry == null || typeof entry !== 'object') continue
      const e = entry as Partial<ClaudeHookEntry>
      if (!Array.isArray(e.hooks)) continue
      const innerHooks = e.hooks.filter((h) => !isManagedSlayzoneHook(h))
      if (innerHooks.length > 0) filtered.push({ ...e, hooks: innerHooks } as ClaudeHookEntry)
    }
    const managed: ClaudeHookEntry = {
      hooks: [
        {
          type: 'command',
          command: notifyPathOnRemote,
          [MARKER_KEY]: true
        }
      ]
    }
    if (TOOL_MATCHED_EVENTS.has(event)) managed.matcher = '*'
    filtered.push(managed)
    hooks[event] = filtered
  }
  settings.hooks = hooks

  const settingsJson = JSON.stringify(settings, null, 2) + '\n'
  await runSshStdin(
    sshExecutable,
    target,
    'mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/settings.json"',
    settingsJson
  )
}

interface ClaudeHookCommand {
  type: 'command'
  command: string
  [MARKER_KEY]?: boolean
}

interface ClaudeHookEntry {
  matcher?: string
  hooks: ClaudeHookCommand[]
}

/** Run a one-shot ssh command, capture stdout. Rejects on non-zero exit. */
function runSsh(
  sshExecutable: string,
  target: string,
  extraArgs: string[],
  remoteCmd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...extraArgs, '--', target, remoteCmd]
    const child = spawn(sshExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout)
      else
        reject(new Error(`ssh ${target} failed (exit ${code}): ${stderr.trim() || '<no stderr>'}`))
    })
  })
}

/** Run a one-shot ssh command, piping `stdin` into the remote command. */
function runSshStdin(
  sshExecutable: string,
  target: string,
  remoteCmd: string,
  stdin: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '--',
      target,
      remoteCmd
    ]
    const child = spawn(sshExecutable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else
        reject(new Error(`ssh ${target} failed (exit ${code}): ${stderr.trim() || '<no stderr>'}`))
    })
    child.stdin.end(stdin)
  })
}
