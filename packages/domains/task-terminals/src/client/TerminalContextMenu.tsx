import { useState, useCallback } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  useShortcutDisplay,
  useAppearance,
  appearanceDefaults
} from '@slayzone/ui'
import {
  Copy,
  ClipboardPaste,
  TextSelect,
  Eraser,
  Search,
  Columns2,
  Plus,
  X,
  PenLine,
  ZoomIn,
  ZoomOut,
  RotateCw,
  ArrowDownToLine,
  Hash,
  Power,
  ServerCog
} from 'lucide-react'
import type { TerminalHandle } from '@slayzone/terminal/client/Terminal'

interface TerminalContextMenuProps {
  children: React.ReactNode
  terminalRef: React.RefObject<TerminalHandle | null>
  sessionId: string
  mode: string
  conversationId?: string | null
  onSplit: () => void
  onNewGroup: () => void
  onClose: (() => void) | null
  onRename: (() => void) | null
  onResetSession: (() => void) | null
  /** ssh-only: project this terminal belongs to. Required for the
   *  "Kill remote session" item (passed to tmux:killSession IPC). */
  projectId?: string | null
  /** ssh-only: true when this tab's project has execution_context.type === 'ssh'.
   *  Gates the "Kill remote session" item from showing on host projects. */
  isSshTarget?: boolean
}

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32

export function TerminalContextMenu({
  children,
  terminalRef,
  sessionId,
  mode,
  conversationId,
  onSplit,
  onNewGroup,
  onClose,
  onRename,
  onResetSession,
  projectId,
  isSshTarget
}: TerminalContextMenuProps) {
  const handleKillRemote = useCallback(async () => {
    if (!projectId || !isSshTarget) return
    const sessionName = `slz-${sessionId.replace(/[:.]/g, '_')}`
    if (
      !window.confirm(
        `Kill the remote tmux session for this tab? This destroys the running agent and clears the stored conversation id.`
      )
    ) {
      return
    }
    try {
      const result = await window.api.tmux.killSession(projectId, sessionName, mode)
      if (!result.ok) {
        // eslint-disable-next-line no-alert
        window.alert(`Kill failed: ${result.message ?? 'unknown error'}`)
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`Kill failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [isSshTarget, mode, projectId, sessionId])
  const [hasSelection, setHasSelection] = useState(false)
  const { terminalFontSize } = useAppearance()

  const searchShortcut = useShortcutDisplay('terminal-search')
  const clearShortcut = useShortcutDisplay('terminal-clear')
  const splitShortcut = useShortcutDisplay('terminal-split')
  const newGroupShortcut = useShortcutDisplay('terminal-new-group')

  const isAiMode = mode !== 'terminal'

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setHasSelection(terminalRef.current?.hasSelection() ?? false)
      } else {
        terminalRef.current?.focus()
      }
    },
    [terminalRef]
  )

  const handleCopy = useCallback(() => {
    const sel = terminalRef.current?.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  }, [terminalRef])

  const handlePaste = useCallback(() => {
    void navigator.clipboard.readText().then((text) => {
      if (text) window.api.pty.write(sessionId, text)
    })
  }, [sessionId])

  const handleSelectAll = useCallback(() => {
    terminalRef.current?.selectAll()
  }, [terminalRef])

  const handleClearBuffer = useCallback(() => {
    void terminalRef.current?.clearBuffer()
  }, [terminalRef])

  const handleSearch = useCallback(() => {
    terminalRef.current?.openSearch()
  }, [terminalRef])

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom()
  }, [terminalRef])

  const handleCopyConversationId = useCallback(() => {
    if (conversationId) void navigator.clipboard.writeText(conversationId)
  }, [conversationId])

  const updateFontSize = useCallback((size: number) => {
    const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size))
    void window.api.settings.set('terminal_font_size', String(clamped))
    window.dispatchEvent(new CustomEvent('sz:settings-changed'))
  }, [])

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {/* Clipboard */}
        <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy}>
          <Copy className="size-4" />
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="size-4" />
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Buffer */}
        <ContextMenuItem onSelect={handleSelectAll}>
          <TextSelect className="size-4" />
          Select All
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleClearBuffer}>
          <Eraser className="size-4" />
          Clear Buffer
          {clearShortcut && <ContextMenuShortcut>{clearShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleSearch}>
          <Search className="size-4" />
          Search
          {searchShortcut && <ContextMenuShortcut>{searchShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Pane management */}
        <ContextMenuItem onSelect={onSplit}>
          <Columns2 className="size-4" />
          Split Pane
          {splitShortcut && <ContextMenuShortcut>{splitShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewGroup}>
          <Plus className="size-4" />
          New Group
          {newGroupShortcut && <ContextMenuShortcut>{newGroupShortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
        {onClose && (
          <ContextMenuItem onSelect={onClose}>
            <X className="size-4" />
            Close Pane
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <PenLine className="size-4" />
            Rename Tab...
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {/* Display */}
        <ContextMenuItem
          disabled={terminalFontSize >= FONT_SIZE_MAX}
          onSelect={() => updateFontSize(terminalFontSize + 1)}
        >
          <ZoomIn className="size-4" />
          Zoom In
        </ContextMenuItem>
        <ContextMenuItem
          disabled={terminalFontSize <= FONT_SIZE_MIN}
          onSelect={() => updateFontSize(terminalFontSize - 1)}
        >
          <ZoomOut className="size-4" />
          Zoom Out
        </ContextMenuItem>
        <ContextMenuItem
          disabled={terminalFontSize === appearanceDefaults.terminalFontSize}
          onSelect={() => updateFontSize(appearanceDefaults.terminalFontSize)}
        >
          <RotateCw className="size-4" />
          Reset Zoom
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleScrollToBottom}>
          <ArrowDownToLine className="size-4" />
          Scroll to Bottom
        </ContextMenuItem>

        {/* AI-specific */}
        {isAiMode && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!conversationId} onSelect={handleCopyConversationId}>
              <Hash className="size-4" />
              Copy Conversation ID
            </ContextMenuItem>
            {onResetSession && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={onResetSession}>
                  <Power className="size-4" />
                  Reset Session
                </ContextMenuItem>
              </>
            )}
            {projectId && isSshTarget && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onSelect={() => {
                    void handleKillRemote()
                  }}
                >
                  <ServerCog className="size-4" />
                  Kill Remote Session
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
