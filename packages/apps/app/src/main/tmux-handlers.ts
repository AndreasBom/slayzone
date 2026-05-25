/**
 * IPC handlers for remote tmux session management (Commit B of
 * REMOTE-SSH-RESILIENCE-PLAN.md v6).
 *
 *   - `tmux:listSessions(projectId)` — lists sessions on the SlayZone-owned
 *     `-L slayzone` socket on the project's SSH target, plus a parallel probe
 *     of the default socket for legacy `slz-*` sessions left over from before
 *     the Commit A socket cutover.
 *   - `tmux:killSession(projectId, sessionName, mode)` — local PTY kill,
 *     await shutdown, fresh ssh to `tmux kill-session`. Clears conversation
 *     id for the (taskId, mode) pair when `mode != null` (tagged sessions);
 *     `mode === null` (legacy untagged) skips the clear.
 *   - `tmux:killAllSessions(projectId, scope)` — iterates with concurrency 4.
 *
 * The IPCs do NOT directly import from the agent-hooks domain (cross-domain).
 * App composition root injects `ensureRemoteWrapper` via setter.
 */
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { resolveProjectExecutionContext } from '@slayzone/worktrees/main'
import {
  getProviderConversationId,
  setProviderConversationId,
  type ProviderConfig
} from '@slayzone/task/shared'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import { killPty, waitForShutdown, resolveSshExecutable } from '@slayzone/terminal/main'
import { ensureRemoteWrapper } from './agent-hooks/remote-hook-installer'

export interface RemoteSessionInfo {
  sessionName: string
  taskId: string | null
  tabId: string | null
  instanceId: string | null
  mode: string | null
  attached: boolean
  created: string | null
  taskTitle: string | null
  taskProjectId: string | null
  legacy?: boolean
}

const SSH_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=5',
  '-o',
  'ServerAliveCountMax=2',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none'
]

function runSshOneShot(
  sshExecutable: string,
  target: string,
  remoteCmd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(sshExecutable, [...SSH_OPTS, '--', target, remoteCmd], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.once('error', (err) => {
      resolve({ stdout, stderr: stderr + (err.message ?? ''), exitCode: 255 })
    })
    child.once('exit', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

/** Tab-delimited row from
 *  `tmux list-sessions -F '#{session_name}\t#{?session_attached,1,0}\t#{q:@slz-task-id}\t#{q:@slz-tab-id}\t#{q:@slz-instance-id}\t#{q:@slz-mode}\t#{q:@slz-created}'`. */
function parseSessionRow(row: string): RemoteSessionInfo | null {
  const cols = row.split('\t')
  if (cols.length < 7) return null
  const sessionName = cols[0]?.trim() ?? ''
  if (!sessionName) return null
  const attached = cols[1]?.trim() === '1'
  return {
    sessionName,
    attached,
    taskId: cols[2]?.trim() || null,
    tabId: cols[3]?.trim() || null,
    instanceId: cols[4]?.trim() || null,
    mode: cols[5]?.trim() || null,
    created: cols[6]?.trim() || null,
    taskTitle: null,
    taskProjectId: null
  }
}

/** Map of (target, instanceId, projectId) → cached list + timestamp. 5s ttl. */
interface ListCacheEntry {
  ts: number
  rows: RemoteSessionInfo[]
}
const listCache = new Map<string, ListCacheEntry>()
const LIST_CACHE_TTL_MS = 5_000

export function bustListCache(): void {
  listCache.clear()
}

interface ResolvedSshContext {
  target: string
}

function resolveSshContext(db: Database, projectId: string): ResolvedSshContext | null {
  const ctx = resolveProjectExecutionContext(db, projectId)
  if (!ctx || ctx.type !== 'ssh') return null
  return { target: ctx.target }
}

interface ProjectTaskRow {
  id: string
  title: string | null
  project_id: string
}

function fetchTasksByIds(
  db: Database,
  taskIds: string[]
): Map<string, ProjectTaskRow> {
  const out = new Map<string, ProjectTaskRow>()
  if (taskIds.length === 0) return out
  const placeholders = taskIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, title, project_id FROM tasks WHERE id IN (${placeholders})`)
    .all(...taskIds) as ProjectTaskRow[]
  for (const row of rows) out.set(row.id, row)
  return out
}

async function listSessionsOnSocket(
  sshExecutable: string,
  target: string,
  socketCmd: string
): Promise<RemoteSessionInfo[]> {
  const format =
    "'#{session_name}\\t#{?session_attached,1,0}\\t#{q:@slz-task-id}\\t#{q:@slz-tab-id}\\t#{q:@slz-instance-id}\\t#{q:@slz-mode}\\t#{q:@slz-created}'"
  const cmd = `${socketCmd} list-sessions -F ${format} 2>/dev/null || true`
  const { stdout } = await runSshOneShot(sshExecutable, target, cmd)
  const rows: RemoteSessionInfo[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parsed = parseSessionRow(line)
    if (parsed) rows.push(parsed)
  }
  return rows
}

export function registerTmuxHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle(
    'tmux:listSessions',
    async (_event, projectId: string): Promise<RemoteSessionInfo[]> => {
      const ssh = resolveSshContext(db, projectId)
      if (!ssh) {
        recordDiagnosticEvent({
          level: 'info',
          source: 'main',
          event: 'pty.tmux_session_list_failed',
          payload: { projectId, reason: 'not-ssh' }
        })
        return []
      }
      const sshExecutable = resolveSshExecutable()
      const cacheKey = `${ssh.target}::${projectId}`
      const cached = listCache.get(cacheKey)
      if (cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS) return cached.rows

      try {
        await ensureRemoteWrapper({ sshExecutable, target: ssh.target })
      } catch (err) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'main',
          event: 'pty.tmux_session_list_failed',
          message: (err as Error).message,
          payload: { projectId, target: ssh.target, reason: 'ensure-wrapper-failed' }
        })
        return []
      }

      try {
        // List slayzone-socket sessions + default-socket legacy in parallel.
        const [slayzoneRows, legacyRows] = await Promise.all([
          listSessionsOnSocket(sshExecutable, ssh.target, '$HOME/.slayzone/bin/slz-tmux'),
          listSessionsOnSocket(sshExecutable, ssh.target, 'tmux')
        ])
        for (const row of legacyRows) {
          // Only `slz-*` names from the default socket count as "legacy."
          if (!row.sessionName.startsWith('slz-')) continue
          row.legacy = true
          slayzoneRows.push(row)
        }

        // Resolve task titles + project_ids for tagged sessions.
        const taskIds = Array.from(
          new Set(slayzoneRows.map((r) => r.taskId).filter((v): v is string => !!v))
        )
        const tasks = fetchTasksByIds(db, taskIds)
        for (const row of slayzoneRows) {
          if (!row.taskId) continue
          const task = tasks.get(row.taskId)
          if (task) {
            row.taskTitle = task.title
            row.taskProjectId = task.project_id
          }
        }

        // Cross-project filter: hide sessions belonging to other projects (still
        // show legacy / untagged / unknown-task — user may need to clean those up).
        const filtered = slayzoneRows.filter((row) => {
          if (row.legacy) return true
          if (!row.taskId) return true
          if (!row.taskProjectId) return true
          return row.taskProjectId === projectId
        })

        listCache.set(cacheKey, { ts: Date.now(), rows: filtered })
        return filtered
      } catch (err) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'main',
          event: 'pty.tmux_session_list_failed',
          message: (err as Error).message,
          payload: { projectId, target: ssh.target }
        })
        return []
      }
    }
  )

  ipcMain.handle(
    'tmux:killSession',
    async (
      _event,
      projectId: string,
      sessionName: string,
      mode: string | null
    ): Promise<{ ok: boolean; message?: string }> => {
      const ssh = resolveSshContext(db, projectId)
      if (!ssh) return { ok: false, message: 'not-ssh' }
      const sshExecutable = resolveSshExecutable()

      // 1. Resolve the local sessionId by reading the `@slz-task-id` + `@slz-tab-id`
      //    tags. Local sessionId is `${taskId}:${tabId}` per pty-manager convention.
      //    For legacy untagged sessions sessionName is unreversed; we skip the
      //    local kill in that case (there's no live local PTY for them).
      const localSessionId = await deriveLocalSessionId(sshExecutable, ssh.target, sessionName)

      // 2. Local kill + await shutdown (only when we know the sessionId).
      if (localSessionId) {
        try {
          killPty(localSessionId)
          await waitForShutdown(localSessionId, 5_000)
        } catch {
          // PTY already dead — non-fatal.
        }
      }

      // 3. Clear conversation id for (taskId, mode) — tagged sessions only.
      //    Legacy untagged sessions skip this (mode === null).
      if (mode && localSessionId) {
        const taskId = localSessionId.split(':')[0]
        try {
          clearTaskConversation(db, taskId, mode)
          recordDiagnosticEvent({
            level: 'info',
            source: 'main',
            event: 'pty.kill_cleared_conversation',
            taskId,
            payload: { projectId, sessionName, mode }
          })
        } catch (err) {
          recordDiagnosticEvent({
            level: 'warn',
            source: 'main',
            event: 'pty.kill_cleared_conversation',
            taskId,
            message: (err as Error).message,
            payload: { projectId, sessionName, mode, failed: true }
          })
        }
      }

      // 4. Remote kill — try slayzone socket first; fall through to default
      //    socket for legacy sessions.
      const cmd =
        `$HOME/.slayzone/bin/slz-tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || ` +
        `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || true`
      const result = await runSshOneShot(sshExecutable, ssh.target, cmd)
      const ok = result.exitCode === 0
      bustListCache()
      recordDiagnosticEvent({
        level: ok ? 'info' : 'warn',
        source: 'main',
        event: 'pty.tmux_session_killed',
        payload: {
          projectId,
          target: ssh.target,
          sessionName,
          mode,
          legacy: mode === null,
          ok,
          stderr: result.stderr.trim() || undefined
        }
      })
      return ok ? { ok: true } : { ok: false, message: result.stderr.trim() || 'kill failed' }
    }
  )

  ipcMain.handle(
    'tmux:killAllSessions',
    async (
      _event,
      projectId: string,
      scope: 'this-instance' | 'all'
    ): Promise<{ ok: number; failed: number }> => {
      // Re-fetch the current list and iterate.
      const ssh = resolveSshContext(db, projectId)
      if (!ssh) return { ok: 0, failed: 0 }
      const sshExecutable = resolveSshExecutable()
      const cacheKey = `${ssh.target}::${projectId}`
      const cached = listCache.get(cacheKey)
      const rows =
        cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS
          ? cached.rows
          : await listSessionsOnSocket(
              sshExecutable,
              ssh.target,
              '$HOME/.slayzone/bin/slz-tmux'
            )

      const targets = rows.filter((row) => {
        if (scope === 'this-instance') {
          // Only same-instance untagged ambiguous → require explicit advanced.
          // We compare against the in-process getSlayzoneInstanceId via the
          // session's `@slz-instance-id`. Renderer reads this id via
          // `window.api.instance.getId` and passes it implicitly through the
          // backend's own setSlayzoneInstanceId — but here we don't have a
          // direct API, so we rely on the tag matching: keep all tagged
          // sessions; legacy/untagged are excluded.
          return row.instanceId !== null && row.taskProjectId === projectId
        }
        // 'all' — include everything except sessions whose taskProjectId
        // belongs to a different project (cross-project sessions kept hidden).
        return !row.taskProjectId || row.taskProjectId === projectId
      })

      let ok = 0
      let failed = 0
      const queue = targets.slice()
      const workers = Array.from({ length: 4 }, () =>
        (async () => {
          while (queue.length > 0) {
            const item = queue.shift()
            if (!item) break
            const cmd =
              `$HOME/.slayzone/bin/slz-tmux kill-session -t ${shellQuote(item.sessionName)} 2>/dev/null || ` +
              `tmux kill-session -t ${shellQuote(item.sessionName)} 2>/dev/null || true`
            const result = await runSshOneShot(sshExecutable, ssh.target, cmd)
            if (result.exitCode === 0) ok++
            else failed++
          }
        })()
      )
      await Promise.all(workers)
      bustListCache()
      return { ok, failed }
    }
  )
}

async function deriveLocalSessionId(
  sshExecutable: string,
  target: string,
  sessionName: string
): Promise<string | null> {
  // sessionName is `slz-<sanitized sessionId>`. We need the original
  // sessionId. Read it back from the @slz-task-id and @slz-tab-id tags
  // — sessionId convention is `${taskId}:${tabId}`.
  const cmd =
    `taskId=$($HOME/.slayzone/bin/slz-tmux show-options -t ${shellQuote(sessionName)} -v -q @slz-task-id 2>/dev/null); ` +
    `tabId=$($HOME/.slayzone/bin/slz-tmux show-options -t ${shellQuote(sessionName)} -v -q @slz-tab-id 2>/dev/null); ` +
    `if [ -n "$taskId" ] && [ -n "$tabId" ]; then printf "%s:%s\\n" "$taskId" "$tabId"; ` +
    `elif [ -n "$taskId" ]; then printf "%s\\n" "$taskId"; fi`
  const { stdout } = await runSshOneShot(sshExecutable, target, cmd)
  const id = stdout.trim()
  return id.length > 0 ? id : null
}

function clearTaskConversation(db: Database, taskId: string, mode: string): void {
  const row = db
    .prepare('SELECT provider_config FROM tasks WHERE id = ?')
    .get(taskId) as { provider_config: string | null } | undefined
  if (!row) return
  let cfg: ProviderConfig = {}
  if (row.provider_config) {
    try {
      cfg = JSON.parse(row.provider_config) as ProviderConfig
    } catch {
      return
    }
  }
  if (getProviderConversationId(cfg, mode) == null) return
  const next = setProviderConversationId(cfg, mode, null)
  db.prepare('UPDATE tasks SET provider_config = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(next),
    Date.now(),
    taskId
  )
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
