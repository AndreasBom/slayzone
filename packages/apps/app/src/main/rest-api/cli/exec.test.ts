import express from 'express'
import http from 'http'
import { EventEmitter } from 'node:events'
import { describe, test, expect, vi, beforeEach } from 'vitest'

// Hoisted spawn spy — vi.mock factories cannot reference module-scope let bindings.
const spawnState = vi.hoisted(() => {
  return {
    lastCall: null as {
      file: string
      args: string[]
      opts: Record<string, unknown>
    } | null,
    nextChild: null as null | ReturnType<typeof makeFakeChild>,
    throwOnSpawn: null as Error | null
  }
})

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => void
  pid: number
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.pid = 1234
  ee.kill = () => undefined
  return ee
}

vi.mock('child_process', () => ({
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
    spawnState.lastCall = { file, args, opts }
    if (spawnState.throwOnSpawn) throw spawnState.throwOnSpawn
    const child = spawnState.nextChild ?? makeFakeChild()
    spawnState.nextChild = null
    return child
  }
}))

vi.mock('@slayzone/platform', () => ({
  getCliBinTarget: () => '/fake/slay'
}))

vi.mock('@slayzone/diagnostics/main', () => ({
  recordDiagnosticEvent: () => undefined
}))

import { registerCliExecRoute } from './exec'

interface ServerHandle {
  port: number
  close(): Promise<void>
}

function startServer(): Promise<ServerHandle> {
  const app = express()
  registerCliExecRoute(app, { db: {} as never, notifyRenderer: () => {} })
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          })
      })
    })
  })
}

function postJson(
  port: number,
  body: unknown
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/cli/exec',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = undefined
          try {
            json = JSON.parse(text)
          } catch {
            /* leave undefined */
          }
          resolve({ status: res.statusCode ?? 0, body: text, json })
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('POST /api/cli/exec', () => {
  beforeEach(() => {
    spawnState.lastCall = null
    spawnState.nextChild = null
    spawnState.throwOnSpawn = null
  })

  test('valid payload → spawns slay with args/cwd and returns stdout/stderr/exitCode', async () => {
    const child = makeFakeChild()
    spawnState.nextChild = child
    const srv = await startServer()
    try {
      const reqP = postJson(srv.port, {
        args: ['projects', 'list', '--json'],
        cwd: '/home/carelogic/logmed',
        env: {
          SLAYZONE_PROJECT_ID: 'proj-1',
          SLAYZONE_TASK_ID: 'task-1'
        }
      })

      // Drive the fake child after the request reaches the handler.
      await new Promise((r) => setTimeout(r, 10))
      child.stdout.emit('data', Buffer.from('[{"id":"proj-1"}]\n'))
      child.stderr.emit('data', Buffer.from('warning: legacy flag\n'))
      child.emit('exit', 0, null)

      const res = await reqP
      expect(res.status).toBe(200)
      expect(res.json).toEqual({
        stdout: '[{"id":"proj-1"}]\n',
        stderr: 'warning: legacy flag\n',
        exitCode: 0
      })
      expect(spawnState.lastCall?.file).toBe('/fake/slay')
      expect(spawnState.lastCall?.args).toEqual(['projects', 'list', '--json'])
      expect(spawnState.lastCall?.opts.cwd).toBe('/home/carelogic/logmed')
      const env = spawnState.lastCall?.opts.env as Record<string, string>
      expect(env.SLAYZONE_PROJECT_ID).toBe('proj-1')
      expect(env.SLAYZONE_TASK_ID).toBe('task-1')
    } finally {
      await srv.close()
    }
  })

  test('only whitelisted env keys propagate', async () => {
    const child = makeFakeChild()
    spawnState.nextChild = child
    const srv = await startServer()
    try {
      const reqP = postJson(srv.port, {
        args: ['tasks', 'list'],
        env: {
          PATH: '/evil/bin',
          NODE_OPTIONS: '--inspect',
          SLAYZONE_TASK_ID: 'task-9'
        }
      })

      await new Promise((r) => setTimeout(r, 10))
      child.emit('exit', 0, null)

      await reqP
      const env = spawnState.lastCall?.opts.env as Record<string, string>
      expect(env.SLAYZONE_TASK_ID).toBe('task-9')
      // PATH from parent process is preserved; the caller's PATH override is dropped.
      expect(env.PATH).not.toBe('/evil/bin')
      expect(env.NODE_OPTIONS).not.toBe('--inspect')
    } finally {
      await srv.close()
    }
  })

  test('non-zero exit code is forwarded', async () => {
    const child = makeFakeChild()
    spawnState.nextChild = child
    const srv = await startServer()
    try {
      const reqP = postJson(srv.port, { args: ['boom'] })
      await new Promise((r) => setTimeout(r, 10))
      child.stderr.emit('data', Buffer.from('command failed\n'))
      child.emit('exit', 2, null)

      const res = await reqP
      expect(res.json).toEqual({
        stdout: '',
        stderr: 'command failed\n',
        exitCode: 2
      })
    } finally {
      await srv.close()
    }
  })

  test('schema validation rejects malformed bodies', async () => {
    const srv = await startServer()
    try {
      const r1 = await postJson(srv.port, { args: [] })
      expect(r1.status).toBe(400)
      const r2 = await postJson(srv.port, {})
      expect(r2.status).toBe(400)
      const r3 = await postJson(srv.port, { args: ['ok'], env: { k: 5 as unknown as string } })
      expect(r3.status).toBe(400)
    } finally {
      await srv.close()
    }
  })

  test('spawn-time errors surface as 500', async () => {
    spawnState.throwOnSpawn = new Error('ENOENT slay')
    const srv = await startServer()
    try {
      const r = await postJson(srv.port, { args: ['version'] })
      expect(r.status).toBe(500)
      expect(r.json).toMatchObject({ ok: false })
    } finally {
      await srv.close()
    }
  })

  test('spawn error event surfaces as 500', async () => {
    const child = makeFakeChild()
    spawnState.nextChild = child
    const srv = await startServer()
    try {
      const reqP = postJson(srv.port, { args: ['version'] })
      await new Promise((r) => setTimeout(r, 10))
      child.emit('error', new Error('EACCES'))

      const res = await reqP
      expect(res.status).toBe(500)
      expect(res.json).toMatchObject({ ok: false })
    } finally {
      await srv.close()
    }
  })
})
