import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import type { Project, ExecutionContext } from '@slayzone/projects/shared'
export type ProjectStartMode = 'scratch' | 'github' | 'linear'

export interface ProjectCreationContext {
  startMode: ProjectStartMode
}

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project, context: ProjectCreationContext) => void
}

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
const START_OPTIONS: Array<{
  mode: ProjectStartMode
  label: string
  description: string
}> = [
  {
    mode: 'scratch',
    label: 'Start from scratch',
    description: 'Create tasks manually and configure integrations later.'
  },
  {
    mode: 'github',
    label: 'Sync with GitHub Projects',
    description: 'Set up project-scoped sync from a GitHub Project board.'
  },
  {
    mode: 'linear',
    label: 'Sync with Linear',
    description: 'Set up project-scoped sync from a Linear team or project.'
  }
]

export function CreateProjectDialog({ open, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(
    () => DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]
  )
  const [path, setPath] = useState('')
  const [location, setLocation] = useState<'local' | 'ssh'>('local')
  const [sshTarget, setSshTarget] = useState('')
  const [remoteWorkdir, setRemoteWorkdir] = useState('')
  const [remoteShell, setRemoteShell] = useState('')
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [startMode, setStartMode] = useState<ProjectStartMode>('scratch')
  const [loading, setLoading] = useState(false)
  const visibleStartOptions = START_OPTIONS

  const handleBrowse = async () => {
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
      // Auto-fill name from folder name if empty
      if (!name.trim()) {
        const folderName = result.filePaths[0].split('/').pop() || ''
        setName(folderName)
      }
    }
  }

  const handleTestSsh = async () => {
    if (!sshTarget.trim()) return
    setTestingConnection(true)
    setTestResult(null)
    const result = await window.api.pty
      .testExecutionContext({ type: 'ssh', target: sshTarget.trim() })
      .catch((e: unknown) => ({
        success: false as const,
        error: e instanceof Error ? e.message : String(e)
      }))
    setTestResult(result)
    setTestingConnection(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    if (location === 'ssh' && !sshTarget.trim()) return

    setLoading(true)
    try {
      // For remote projects, persist the remote workdir as the project path so
      // every surface that displays "where this project lives" shows the
      // remote path the user typed. Local fs surfaces (file watcher, blob
      // store) still see this string but will be progressively disabled when
      // execution_context.type === 'ssh' in a follow-up.
      const effectivePath =
        location === 'ssh' ? remoteWorkdir.trim() || undefined : path || undefined

      const project = await window.api.db.createProject({
        name: name.trim(),
        color,
        path: effectivePath
      })

      if (location === 'ssh') {
        const executionContext: ExecutionContext = {
          type: 'ssh',
          target: sshTarget.trim(),
          ...(remoteWorkdir.trim() ? { workdir: remoteWorkdir.trim() } : {}),
          ...(remoteShell.trim() ? { shell: remoteShell.trim() } : {})
        }
        const updated = await window.api.db.updateProject({
          id: project.id,
          executionContext
        })
        onCreated(updated, { startMode })
      } else {
        onCreated(project, { startMode })
      }

      setName('')
      setPath('')
      setSshTarget('')
      setRemoteWorkdir('')
      setRemoteShell('')
      setLocation('local')
      setTestResult(null)
      setStartMode('scratch')
      setColor(DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Where does the repository live?</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLocation('local')}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2 text-left transition-colors',
                  location === 'local'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <p className="text-sm font-medium">On this machine</p>
                <p className="text-xs text-muted-foreground">Local folder</p>
              </button>
              <button
                type="button"
                onClick={() => setLocation('ssh')}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2 text-left transition-colors',
                  location === 'ssh'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <p className="text-sm font-medium">On a remote machine (SSH)</p>
                <p className="text-xs text-muted-foreground">Agents run there via tmux</p>
              </button>
            </div>
          </div>
          {location === 'local' && (
            <div className="space-y-2">
              <Label htmlFor="path">Repository Path</Label>
              <div className="flex gap-2">
                <Input
                  id="path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/repo"
                  className="flex-1"
                />
                <IconButton
                  type="button"
                  variant="outline"
                  aria-label="Browse folder"
                  onClick={handleBrowse}
                >
                  <FolderOpen className="h-4 w-4" />
                </IconButton>
              </div>
              <p className="text-xs text-muted-foreground">
                Agent terminals open in this directory.
              </p>
            </div>
          )}
          {location === 'ssh' && (
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="space-y-1">
                <Label htmlFor="ssh-target">Host</Label>
                <Input
                  id="ssh-target"
                  value={sshTarget}
                  onChange={(e) => setSshTarget(e.target.value)}
                  placeholder="user@hostname"
                />
                <p className="text-xs text-muted-foreground">
                  Anything <code className="font-mono">ssh</code> accepts as a destination, including
                  entries from <code className="font-mono">~/.ssh/config</code>.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ssh-workdir">Repository path on remote</Label>
                <Input
                  id="ssh-workdir"
                  value={remoteWorkdir}
                  onChange={(e) => setRemoteWorkdir(e.target.value)}
                  placeholder="/home/user/project"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ssh-shell">Shell on remote</Label>
                <Input
                  id="ssh-shell"
                  value={remoteShell}
                  onChange={(e) => setRemoteShell(e.target.value)}
                  placeholder="/bin/bash"
                />
                <p className="text-xs text-muted-foreground">Defaults to /bin/bash.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!sshTarget.trim() || testingConnection}
                  onClick={handleTestSsh}
                >
                  {testingConnection ? 'Testing...' : 'Test connection'}
                </Button>
                {testResult && (
                  <span
                    className={cn(
                      'text-xs',
                      testResult.success ? 'text-green-500' : 'text-red-500'
                    )}
                  >
                    {testResult.success ? 'Connected' : testResult.error || 'Failed'}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Sessions run inside <code className="font-mono">tmux</code> on the remote host so
                they survive SSH disconnects. Make sure <code className="font-mono">tmux</code> is
                installed there and key-based auth is set up.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="space-y-2">
            <Label>How do you want to start this project?</Label>
            <div className="space-y-2">
              {visibleStartOptions.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => setStartMode(option.mode)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    startMode === option.mode
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50'
                  )}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !name.trim() || loading || (location === 'ssh' && !sshTarget.trim())
              }
            >
              {startMode === 'scratch' ? 'Create' : 'Create and continue'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
