import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  sendUserMessage,
  ensureSpawned,
  getSessionInfo,
  getSessionTerminalState,
  isSessionAwaitingUserInput,
  registerChatQueueDrainer,
} from './chat-transport-manager'
import {
  listChatQueue,
  pushChatQueue,
  removeChatQueueItem,
  clearChatQueue,
  popChatQueueHead,
  requeueAtHead,
} from './chat-queue-store'
import type { QueuedChatMessage } from '../shared/types'

/**
 * Lazy electron broadcast — same trick as chat-transport-manager so this file
 * stays importable from non-electron test contexts. In production wires
 * `chat:queue-changed` (refetch trigger) + `chat:queue-drained` (analytics).
 */
function broadcast(channel: 'chat:queue-changed' | 'chat:queue-drained', ...args: unknown[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send(channel, ...args)
    }
  } catch {
    /* non-electron context */
  }
}

/**
 * Drain head of queue if the session is currently idle. Called by the
 * transport on state→idle transitions and on push (covers the "queue
 * persisted across restart, session boots into idle, no fresh transition
 * fires" case). Gated on `terminalState === 'idle'` so drains during a
 * live turn don't interleave with the in-flight assistant response.
 *
 * Extra gate: `isSessionAwaitingUserInput` blocks drain during an inbound
 * permission-request (AskUserQuestion etc.) — that idle flip is "waiting on
 * user", not "free to send next turn"; a user_message here would race the
 * SDK's pending tool_result.
 *
 * Pop is atomic via a transaction; if `sendUserMessage` fails we
 * re-insert at head so the next drain retries.
 */
export function drainChatQueue(db: Database, tabId: string): void {
  const state = getSessionTerminalState(tabId)
  // Pre-spawn lazy trigger: a queued message arrived before the user ever
  // sent one (so the subprocess was never started). Fire ensureSpawned —
  // when it transitions through `starting → idle`, the transport's drainer
  // hook re-enters this function and the post-spawn branch below pops the
  // queue. Only trigger when there's actually something queued to avoid
  // spinning up a process for nothing.
  if (state === 'not-spawned') {
    if (listChatQueue(db, tabId).length === 0) return
    void ensureSpawned(tabId).catch((err) => {
      console.error('[chat-queue] ensureSpawned failed for pre-spawn drain:', err)
    })
    return
  }
  if (state !== 'idle') return
  if (isSessionAwaitingUserInput(tabId)) return
  const info = getSessionInfo(tabId)
  if (!info || info.ended) return

  const head = popChatQueueHead(db, tabId)
  if (!head) return

  const sent = sendUserMessage(tabId, head.send)
  if (!sent) {
    // Session died between gate-check and stdin write. Put it back so the
    // next idle transition (e.g. fresh respawn) can retry.
    try {
      requeueAtHead(db, head)
    } catch (err) {
      console.error('[chat-queue] requeue failed:', err)
    }
    return
  }
  broadcast('chat:queue-changed', tabId)
  // `original` carries the raw `/cmd` token so the renderer's usage hook
  // bumps autocomplete tiebreak counts for the real input — not the
  // post-transform expansion.
  broadcast('chat:queue-drained', tabId, head.original)
}

export function registerChatQueueHandlers(ipcMain: IpcMain, db: Database): void {
  // Wire drain into the transport so state transitions can pull from queue.
  registerChatQueueDrainer((tabId) => drainChatQueue(db, tabId))

  ipcMain.handle('chat:queue:list', (_, tabId: string): QueuedChatMessage[] => {
    return listChatQueue(db, tabId)
  })

  ipcMain.handle(
    'chat:queue:push',
    (_, tabId: string, send: string, original: string): QueuedChatMessage => {
      const msg = pushChatQueue(db, tabId, send, original)
      broadcast('chat:queue-changed', tabId)
      // Belt-and-suspenders drain: if the session is already idle when push
      // lands (renderer's inFlight mirror lags the transport), no fresh
      // state transition is coming — kick the drainer so the queue doesn't
      // sit. drainChatQueue itself gates on idle so this is safe.
      drainChatQueue(db, tabId)
      return msg
    }
  )

  ipcMain.handle('chat:queue:remove', (_, id: string): boolean => {
    const row = db.prepare('SELECT tab_id FROM chat_queue WHERE id = ?').get(id) as
      | { tab_id: string }
      | undefined
    const removed = removeChatQueueItem(db, id)
    if (removed && row) broadcast('chat:queue-changed', row.tab_id)
    return removed
  })

  ipcMain.handle('chat:queue:clear', (_, tabId: string): number => {
    const cleared = clearChatQueue(db, tabId)
    if (cleared > 0) broadcast('chat:queue-changed', tabId)
    return cleared
  })
}
