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
 *   ~/.slayzone/bin/slay           (mode 0755 — CLI proxy to host)
 *   ~/.claude/settings.json        (merged, preserves user-defined entries)
 *
 * Failures bubble up so the caller can decide whether to block the spawn or
 * proceed without hook plumbing (and accept degraded status reporting).
 */
import { spawn } from 'child_process'
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import notifyScriptSource from '@slayzone/hooks/notify.sh?raw'
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import slayProxyScriptSource from '@slayzone/hooks/slay-proxy.sh?raw'
import { CLAUDE_HOOK_EVENTS, isManagedSlayzoneHook } from './claude-hook-installer'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'

// Pin tpm + tmux-resurrect to known-good tags; continuum has no stable tags
// at the time of writing, take latest main (re-evaluate on plan v6 followup).
const TPM_VERSION = 'v3.1.0'
const RESURRECT_VERSION = 'v4.0.0'
const TMUX_RESILIENCE_VERSION = 'v1'
const SLAYZONE_TMUX_CONF = `# SLAYZONE_CONF_VERSION=${TMUX_RESILIENCE_VERSION}
# Managed by SlayZone. Edit only via SlayZone.

set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'

# Save automatically every 15 minutes. Auto-restore intentionally NOT enabled
# (it would conflict with \`tmux new-session -A\` and resurrect zombie sessions
# the user has since deleted from SlayZone).
set -g @continuum-save-interval '15'
set -g @resurrect-capture-pane-contents 'on'
set -g @resurrect-dir '~/.slayzone/tmux-state'

# Continuum's autosave subprocess inherits \$TMUX from the running server
# (started via slz-tmux), so saves stay on the slayzone socket.
set -g @continuum-save-args '-L slayzone'

run-shell '~/.tmux/plugins/tpm/tpm'
`

const SLZ_TMUX_WRAPPER = `#!/bin/sh
# Managed by SlayZone. Pins the SlayZone socket and config file on every
# tmux invocation. Edit only via SlayZone.
exec tmux -L slayzone -f "$HOME/.tmux/slayzone.conf" "$@"
`

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

  // 1. Probe remote $HOME + curl + jq + tmux version + flock variant.
  // Single round trip. jq is required by slay-proxy.sh for safe argv → JSON
  // encoding; tmux + flock results gate the Step 1 (tmux resilience) install.
  const probe = await runSsh(
    sshExecutable,
    target,
    [],
    'printf "%s\\n" "$HOME"; ' +
      'command -v curl >/dev/null 2>&1 && echo CURL_OK || echo CURL_MISSING; ' +
      'command -v jq >/dev/null 2>&1 && echo JQ_OK || echo JQ_MISSING; ' +
      'tmux -V 2>/dev/null || echo TMUX_MISSING; ' +
      'flock -V 2>/dev/null | head -n1 || echo FLOCK_MISSING'
  )
  const probeLines = probe.trim().split(/\r?\n/)
  const remoteHome = probeLines[0]?.trim()
  const curlStatus = probeLines[1]?.trim()
  const jqStatus = probeLines[2]?.trim()
  const tmuxLine = probeLines[3]?.trim() ?? 'TMUX_MISSING'
  const flockLine = probeLines[4]?.trim() ?? 'FLOCK_MISSING'
  if (!remoteHome) throw new Error(`remote $HOME empty for ${target}`)
  if (curlStatus !== 'CURL_OK') {
    throw new Error(
      `remote ${target} is missing curl — install it (apt install curl / dnf install curl) so notify.sh can post hook events`
    )
  }
  if (jqStatus !== 'JQ_OK') {
    // Non-fatal for notify.sh, fatal for slay-proxy. We still install
    // notify.sh and surface a clearer error so the user knows the `slay` CLI
    // proxy won't work until jq is present.
    throw new Error(
      `remote ${target} is missing jq — install it (apt install jq / dnf install jq) so the slay CLI proxy can encode arguments safely`
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

  // 2b. Write slay CLI proxy with mode 0755. Shadows any pre-existing remote
  // `slay` once ~/.slayzone/bin is on PATH (handled by transport-spawn).
  const slayProxyScript =
    typeof slayProxyScriptSource === 'string'
      ? slayProxyScriptSource
      : String(slayProxyScriptSource)
  const slayProxyScriptLf = slayProxyScript.replace(/\r\n/g, '\n')
  await runSshStdin(
    sshExecutable,
    target,
    'mkdir -p "$HOME/.slayzone/bin" && cat > "$HOME/.slayzone/bin/slay" && chmod 0755 "$HOME/.slayzone/bin/slay"',
    slayProxyScriptLf
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

  // 4. Install tmux state-persistence plugins on the SlayZone-owned socket.
  // Best-effort: failures emit a diagnostic event but don't throw — the
  // notify.sh + slay-proxy hooks above must keep working even on hosts where
  // tmux is too old or GitHub is unreachable.
  await installTmuxResilience({
    sshExecutable,
    target,
    remoteHome,
    tmuxLine,
    flockLine
  })
}

interface TmuxResilienceOpts {
  sshExecutable: string
  target: string
  remoteHome: string
  tmuxLine: string
  flockLine: string
}

/** Parse "tmux 2.6" / "tmux next-3.4" / "TMUX_MISSING" → numeric major.minor. */
function parseTmuxVersion(line: string): { major: number; minor: number } | null {
  const m = /^tmux[\s-]?(?:next-)?(\d+)\.(\d+)/i.exec(line.trim())
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) }
}

async function installTmuxResilience(opts: TmuxResilienceOpts): Promise<void> {
  const { sshExecutable, target, remoteHome, tmuxLine, flockLine } = opts
  const skipDiag = (reason: string) =>
    recordDiagnosticEvent({
      level: 'info',
      source: 'main',
      event: 'pty.tmux_persistence_skipped',
      payload: { target, reason }
    })

  // Probe parsing.
  const version = parseTmuxVersion(tmuxLine)
  if (!version) {
    skipDiag(`tmux-missing: ${tmuxLine}`)
    return
  }
  // tmux-continuum requires >= 2.1; tmux-resurrect >= 1.9. Floor at 2.1.
  if (version.major < 2 || (version.major === 2 && version.minor < 1)) {
    skipDiag(`tmux-too-old: ${version.major}.${version.minor}`)
    return
  }

  const hasUtilLinuxFlock = /^flock from util-linux/.test(flockLine)

  // Migration marker — written LAST, after every install step succeeds, so
  // partial-install retries don't skip the unfinished install.
  const migrationMarker = `${remoteHome}/.slayzone/migration-done.${TMUX_RESILIENCE_VERSION}`
  const markerExisting = await runSsh(
    sshExecutable,
    target,
    [],
    `[ -f ${shellQuote(migrationMarker)} ] && echo PRESENT || echo MISSING`
  )
  if (markerExisting.trim() === 'PRESENT') {
    // Already installed for this version. Verify wrapper + conf still present;
    // if either is missing (user manually deleted) bust the marker and reinstall.
    const verify = await runSsh(
      sshExecutable,
      target,
      [],
      '[ -x "$HOME/.slayzone/bin/slz-tmux" ] && [ -r "$HOME/.tmux/slayzone.conf" ] && echo OK || echo MISSING'
    )
    if (verify.trim() === 'OK') return
    await runSsh(sshExecutable, target, [], `rm -f ${shellQuote(migrationMarker)}`)
  }

  // Acquire install lock. util-linux flock supports -w; busybox doesn't, so
  // we fall back to mkdir-trap as the atomic lock primitive.
  const lockCmd = hasUtilLinuxFlock
    ? 'flock -w 60 "$HOME/.slayzone/install.lock" --'
    : '' // mkdir guard below handles serialization
  const lockGuard = hasUtilLinuxFlock
    ? ''
    : 'while ! mkdir "$HOME/.slayzone/install.lock.d" 2>/dev/null; do sleep 1; done; ' +
      'trap \'rmdir "$HOME/.slayzone/install.lock.d" 2>/dev/null\' EXIT INT TERM; '

  // tpm + resurrect + continuum clone, with idempotent "fetch+checkout if
  // .git exists, else clone" guards. continuum has no stable tag (latest main).
  const cloneScript = `set -e
mkdir -p "$HOME/.tmux/plugins" "$HOME/.slayzone/bin"
${lockGuard}clone_or_update() {
  dir="$1"
  url="$2"
  ref="$3"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --tags --depth 1 origin "$ref" 2>/dev/null \\
      && git -C "$dir" checkout "$ref" 2>/dev/null \\
      || { rm -rf "$dir"; git clone --branch "$ref" --depth 1 "$url" "$dir"; }
  else
    rm -rf "$dir"
    if [ -n "$ref" ]; then
      git clone --branch "$ref" --depth 1 "$url" "$dir"
    else
      git clone --depth 1 "$url" "$dir"
    fi
  fi
}
clone_or_update "$HOME/.tmux/plugins/tpm" https://github.com/tmux-plugins/tpm ${TPM_VERSION}
clone_or_update "$HOME/.tmux/plugins/tmux-resurrect" https://github.com/tmux-plugins/tmux-resurrect ${RESURRECT_VERSION}
clone_or_update "$HOME/.tmux/plugins/tmux-continuum" https://github.com/tmux-plugins/tmux-continuum ""
`
  try {
    await runSsh(
      sshExecutable,
      target,
      [],
      hasUtilLinuxFlock ? `${lockCmd} sh -c ${shellQuote(cloneScript)}` : cloneScript
    )
  } catch (err) {
    skipDiag(`plugin-clone-failed: ${(err as Error).message}`)
    return
  }

  // Write slayzone.conf and the slz-tmux wrapper.
  try {
    await runSshStdin(
      sshExecutable,
      target,
      'mkdir -p "$HOME/.tmux" && cat > "$HOME/.tmux/slayzone.conf"',
      SLAYZONE_TMUX_CONF
    )
    await runSshStdin(
      sshExecutable,
      target,
      'mkdir -p "$HOME/.slayzone/bin" && cat > "$HOME/.slayzone/bin/slz-tmux" && chmod 0755 "$HOME/.slayzone/bin/slz-tmux"',
      SLZ_TMUX_WRAPPER
    )
  } catch (err) {
    skipDiag(`conf-or-wrapper-write-failed: ${(err as Error).message}`)
    return
  }

  // Headless plugin install via the wrapper, idempotent: kill any stale
  // _slz_install pane, then `new-session -A` so a still-living one attaches
  // rather than failing.
  try {
    await runSsh(
      sshExecutable,
      target,
      [],
      '"$HOME/.slayzone/bin/slz-tmux" kill-session -t _slz_install 2>/dev/null || true; ' +
        '"$HOME/.slayzone/bin/slz-tmux" new-session -A -d -s _slz_install ' +
        "'~/.tmux/plugins/tpm/bin/install_plugins; ~/.slayzone/bin/slz-tmux kill-server' " +
        '|| true'
    )
  } catch {
    // Plugin install failure doesn't unwind the install — the wrapper +
    // conf still let basic tmux work, just without auto-save.
  }

  // CC1c migration: surface or kill legacy default-socket slz-* sessions.
  // Runs every install (idempotent); marker prevents re-running on next spawn.
  try {
    const legacyList = await runSsh(
      sshExecutable,
      target,
      [],
      'tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^slz-" || true'
    )
    const legacy = legacyList
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const name of legacy) {
      const tagged = await runSsh(
        sshExecutable,
        target,
        [],
        `tmux show-options -t ${shellQuote(name)} -v -q @slz-task-id 2>/dev/null || true`
      )
      if (tagged.trim().length > 0) {
        // Tagged legacy session — defensive paranoia; kill it so the new
        // `-L slayzone` session takes over via existingConversationId.
        await runSsh(
          sshExecutable,
          target,
          [],
          `tmux kill-session -t ${shellQuote(name)} 2>/dev/null || true`
        )
        recordDiagnosticEvent({
          level: 'info',
          source: 'main',
          event: 'pty.tmux_legacy_session_killed',
          payload: { target, sessionName: name }
        })
      } else {
        // Untagged legacy session — surface; user kills manually in the
        // Step 2 panel.
        recordDiagnosticEvent({
          level: 'info',
          source: 'main',
          event: 'pty.tmux_legacy_session_surfaced',
          payload: { target, sessionName: name }
        })
      }
    }
  } catch {
    // List failure is acceptable — migration is best-effort.
  }

  // Marker LAST so a partial-install never skips re-running the migration.
  try {
    await runSsh(
      sshExecutable,
      target,
      [],
      `touch ${shellQuote(migrationMarker)}`
    )
  } catch {
    /* marker write failure: next spawn re-runs everything, harmless */
  }

  recordDiagnosticEvent({
    level: 'info',
    source: 'main',
    event: 'pty.tmux_persistence_installed',
    payload: {
      target,
      tmuxVersion: `${version.major}.${version.minor}`,
      utilLinuxFlock: hasUtilLinuxFlock
    }
  })
}

/** POSIX shell single-quote escape — safe for passing through ssh + sh -c. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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
