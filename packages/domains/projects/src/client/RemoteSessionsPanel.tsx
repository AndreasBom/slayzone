/**
 * Project Settings → "Remote sessions" panel.
 *
 * Implements Commit B of REMOTE-SSH-RESILIENCE-PLAN.md v6 step 2b: lists
 * `slz-*` tmux sessions on the project's SSH target, with per-row Kill +
 * "Kill all owned by this SlayZone" + "Kill all (advanced)". Legacy
 * default-socket sessions render in a separate group with explicit warning
 * copy. Cross-project filter is enforced by the backend IPC, so the panel
 * only sees sessions whose `@slz-task-id` resolves to a task in THIS
 * project (plus untagged / legacy).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconButton, cn, toast } from '@slayzone/ui'
import { Loader2, RefreshCw, X } from 'lucide-react'

interface RemoteSessionInfo {
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

interface RemoteSessionsPanelProps {
  projectId: string
  /** Rendered "(this SlayZone)" / "(other SlayZone)" labels — comes from
   *  `window.api.instance.getId()` on mount. */
  ownInstanceId: string | null
}

export function RemoteSessionsPanel({
  projectId,
  ownInstanceId
}: RemoteSessionsPanelProps): React.ReactElement {
  const [sessions, setSessions] = useState<RemoteSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [killing, setKilling] = useState<Set<string>>(new Set())
  const [killingAll, setKillingAll] = useState(false)
  const [confirmingRow, setConfirmingRow] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await window.api.tmux.listSessions(projectId)
      setSessions(rows)
    } catch (err) {
      toast.error(
        `Failed to list remote sessions: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const tagged = sessions.filter((s) => !s.legacy)
  const legacy = sessions.filter((s) => s.legacy)

  const handleKill = useCallback(
    async (row: RemoteSessionInfo) => {
      if (confirmingRow !== row.sessionName) {
        setConfirmingRow(row.sessionName)
        // Auto-clear confirm after 5s if user doesn't follow through.
        window.setTimeout(() => {
          setConfirmingRow((current) => (current === row.sessionName ? null : current))
        }, 5_000)
        return
      }
      setConfirmingRow(null)
      const key = row.sessionName
      setKilling((prev) => {
        const next = new Set(prev)
        next.add(key)
        return next
      })
      try {
        const result = await window.api.tmux.killSession(projectId, row.sessionName, row.mode)
        if (!result.ok) {
          toast.error(`Kill failed: ${result.message ?? 'unknown error'}`)
        } else {
          setSessions((prev) => prev.filter((s) => s.sessionName !== row.sessionName))
        }
      } catch (err) {
        toast.error(`Kill failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setKilling((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [confirmingRow, projectId]
  )

  const handleKillAll = useCallback(
    async (scope: 'this-instance' | 'all') => {
      if (
        !window.confirm(
          scope === 'all'
            ? `Kill ALL remote sessions on this target (including other SlayZone instances)? Conversation state is preserved for sessions tagged with @slz-task-id; legacy untagged sessions are killed without affecting any task state.`
            : `Kill all remote sessions owned by this SlayZone on this target?`
        )
      ) {
        return
      }
      setKillingAll(true)
      try {
        const result = await window.api.tmux.killAllSessions(projectId, scope)
        toast.success(`Killed ${result.ok} session(s). ${result.failed} failed.`)
        await refresh()
      } catch (err) {
        toast.error(`Kill-all failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setKillingAll(false)
      }
    },
    [projectId, refresh]
  )

  const renderRow = useCallback(
    (row: RemoteSessionInfo) => {
      const isThisInstance = row.instanceId && row.instanceId === ownInstanceId
      const isOtherInstance = row.instanceId && row.instanceId !== ownInstanceId
      const isKilling = killing.has(row.sessionName)
      const isConfirming = confirmingRow === row.sessionName
      const isLegacy = !!row.legacy
      return (
        <div
          key={row.sessionName}
          className={cn(
            'flex items-center gap-3 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm',
            isLegacy && 'border-amber-500/50'
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {row.sessionName}
              </span>
              {row.attached && (
                <span className="rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary">
                  attached
                </span>
              )}
              {isThisInstance && (
                <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                  this SlayZone
                </span>
              )}
              {isOtherInstance && (
                <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-400">
                  other SlayZone
                </span>
              )}
              {isLegacy && (
                <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-400">
                  legacy (default socket)
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-foreground">
              {row.taskTitle ?? (isLegacy ? 'Unknown task — no SlayZone metadata' : 'Unknown task')}
              {row.mode && (
                <span className="ml-2 text-muted-foreground">· {row.mode}</span>
              )}
              {row.created && (
                <span className="ml-2 text-muted-foreground">· {row.created}</span>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant={isConfirming ? 'destructive' : 'ghost'}
            disabled={isKilling || killingAll}
            onClick={() => {
              void handleKill(row)
            }}
            className="shrink-0"
          >
            {isKilling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isConfirming ? (
              'Click to confirm'
            ) : (
              'Kill'
            )}
          </Button>
        </div>
      )
    },
    [confirmingRow, handleKill, killing, killingAll, ownInstanceId]
  )

  const ownedCount = useMemo(
    () => tagged.filter((s) => !s.instanceId || s.instanceId === ownInstanceId).length,
    [tagged, ownInstanceId]
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Remote sessions</div>
          <div className="text-xs text-muted-foreground">
            tmux sessions on this project&apos;s SSH target
          </div>
        </div>
        <IconButton
          size="icon-sm"
          variant="ghost"
          disabled={loading}
          onClick={() => {
            void refresh()
          }}
          aria-label="Refresh"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </IconButton>
      </div>

      {loading && sessions.length === 0 ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No remote sessions on this target.
        </div>
      ) : (
        <>
          {tagged.length > 0 && (
            <div className="space-y-2">
              {tagged.map(renderRow)}
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={killingAll || ownedCount === 0}
                  onClick={() => {
                    void handleKillAll('this-instance')
                  }}
                >
                  {killingAll ? (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  ) : (
                    <X className="mr-2 h-3 w-3" />
                  )}
                  Kill all owned by this SlayZone ({ownedCount})
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? 'Hide advanced' : 'Show advanced'}
                </Button>
              </div>
              {showAdvanced && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={killingAll}
                  onClick={() => {
                    void handleKillAll('all')
                  }}
                >
                  Kill all (including other-instance)
                </Button>
              )}
            </div>
          )}

          {legacy.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                Legacy sessions (default socket)
              </div>
              <div className="text-[11px] text-muted-foreground">
                No SlayZone metadata; killing only removes the tmux session and does not affect any
                task&apos;s stored agent state. On next open of any task previously on one of these
                sessions, SlayZone will fail to resume once and recover via fresh start.
              </div>
              {legacy.map(renderRow)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
