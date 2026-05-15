import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { describe, test, expect } from 'vitest'
import { installNotifyScript } from './notify-script-installer'

/**
 * Integration test: invoke installed notify.sh with Codex-style argv payloads
 * (real codex passes JSON via argv $1, not stdin) and verify the script POSTs
 * an envelope with the expected hookEvent name. Curl is shadowed via PATH
 * with a stub that captures the request body to a file.
 */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-notify-codex-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

function writeCurlStub(binDir: string, capturePath: string) {
  const stub = `#!/bin/bash\n# Capture --data-binary value to ${capturePath} then exit 0.\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    --data-binary) shift; printf '%s' "$1" > "${capturePath}";;\n  esac\n  shift\ndone\nexit 0\n`
  const stubPath = path.join(binDir, 'curl')
  fs.writeFileSync(stubPath, stub, { mode: 0o755 })
}

describe('notify.sh + codex argv input', () => {
  test('extracts hook_event_name from argv payload', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const argv = '{"hook_event_name":"Start","extra":"x"}'
      const res = spawnSync('bash', [target, argv], {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'codex',
          SLAYZONE_TASK_ID: 'task-1',
        },
      })
      expect(res.status).toBe(0)
      const captured = fs.readFileSync(capture, 'utf8')
      const env = JSON.parse(captured)
      expect(env.agentId).toBe('codex')
      expect(env.hookEvent).toBe('Start')
      expect(env.taskId).toBe('task-1')
      expect(env.raw.hook_event_name).toBe('Start')
    } finally {
      cleanup(dir)
    }
  })

  test('falls back to "type" field for native codex completion payload', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const argv = '{"type":"agent-turn-complete","turn_id":"t1"}'
      const res = spawnSync('bash', [target, argv], {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'codex',
        },
      })
      expect(res.status).toBe(0)
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      expect(env.hookEvent).toBe('agent-turn-complete')
    } finally {
      cleanup(dir)
    }
  })

  test('still reads stdin when argv empty (Claude path back-compat)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const binDir = path.join(dir, 'bin')
      fs.mkdirSync(binDir)
      const capture = path.join(dir, 'capture.json')
      writeCurlStub(binDir, capture)

      const stdinPayload = '{"hook_event_name":"Stop","session_id":"s1"}'
      const res = spawnSync('bash', [target], {
        input: stdinPayload,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:1/api/agent-hook',
          SLAYZONE_AGENT_ID: 'claude-code',
        },
      })
      expect(res.status).toBe(0)
      const env = JSON.parse(fs.readFileSync(capture, 'utf8'))
      expect(env.agentId).toBe('claude-code')
      expect(env.hookEvent).toBe('Stop')
    } finally {
      cleanup(dir)
    }
  })

  test('exits 0 silently when hook URL not configured', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'notify.sh')
      await installNotifyScript({ targetPath: target })

      const res = spawnSync('bash', [target, '{"type":"x"}'], {
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(res.status).toBe(0)
    } finally {
      cleanup(dir)
    }
  })
})
