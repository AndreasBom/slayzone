import { useCallback, useEffect, useState } from 'react'
import { toast } from '@slayzone/ui'
import { DEFAULT_CHAT_FAST_MODE } from '@slayzone/terminal/shared'

interface SessionInfoLite {
  chatFastMode?: boolean
}

interface UseChatFastModeOpts {
  taskId: string
  mode: string
  tabId: string
  cwd: string
}

interface ChatFastModeApi {
  setFastMode: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    chatFastMode: boolean
  }) => Promise<SessionInfoLite>
  getFastMode: (taskId: string, mode: string) => Promise<boolean>
  getInfo: (tabId: string) => Promise<SessionInfoLite | null>
}

function getApi(): ChatFastModeApi {
  return (window as unknown as { api: { chat: ChatFastModeApi } }).api.chat
}

/**
 * Owns chat Fast Mode state (Codex `serviceTier: 'fast'`). Mirrors
 * useChatEffort: server-authoritative, hydrate from live session > DB cache,
 * kill+respawn on change.
 *
 * Only meaningful for `codex-chat`; the control is hidden for other modes.
 */
export function useChatFastMode({ taskId, mode, tabId, cwd }: UseChatFastModeOpts) {
  const [chatFastMode, setChatFastModeState] = useState<boolean>(DEFAULT_CHAT_FAST_MODE)
  const [fastModeChanging, setFastModeChanging] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await getApi().getInfo(tabId)
        if (cancelled) return
        if (info && typeof info.chatFastMode === 'boolean') {
          setChatFastModeState(info.chatFastMode)
          return
        }
        const cached = await getApi().getFastMode(taskId, mode)
        if (!cancelled) setChatFastModeState(cached ?? DEFAULT_CHAT_FAST_MODE)
      } catch {
        /* keep DEFAULT_CHAT_FAST_MODE */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, mode, tabId])

  const handleFastModeChange = useCallback(
    async (next: boolean) => {
      if (next === chatFastMode || fastModeChanging) return
      setFastModeChanging(true)
      try {
        const info = await getApi().setFastMode({ tabId, taskId, mode, cwd, chatFastMode: next })
        if (info && typeof info.chatFastMode === 'boolean') setChatFastModeState(info.chatFastMode)
        else setChatFastModeState(next)
      } catch (err) {
        toast(`Fast mode change failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setFastModeChanging(false)
      }
    },
    [chatFastMode, fastModeChanging, tabId, taskId, mode, cwd]
  )

  return { chatFastMode, fastModeChanging, handleFastModeChange }
}
