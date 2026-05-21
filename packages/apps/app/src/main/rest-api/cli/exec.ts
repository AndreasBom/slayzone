import type { Express } from 'express'
import express from 'express'
import { spawn } from 'child_process'
import { z } from 'zod'
import { getCliBinTarget } from '@slayzone/platform'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { RestApiDeps } from '../types'

/**
 * `slay` CLI proxy endpoint.
 *
 * Remote SSH agents spawn `~/.slayzone/bin/slay` (a thin shell script — see
 * `packages/shared/hooks/src/slay-proxy.sh`) which POSTs here over the
 * reverse-forwarded MCP loopback. We run the real host `slay` binary with the
 * forwarded args, cwd, and a small whitelist of forwarded env vars, then
 * stream back `{ stdout, stderr, exitCode }`.
 *
 * The endpoint is loopback-only (the MCP server binds to 127.0.0.1) and the
 * only inputs that influence host state are the args themselves — same
 * surface as if the user typed `slay <cmd>` locally. We keep an explicit env
 * whitelist (just `SLAYZONE_PROJECT_ID` / `SLAYZONE_TASK_ID`) so a hostile
 * caller can't inject PATH or other process-wide env into the spawn.
 */

const MAX_BODY_BYTES = 256 * 1024
const MAX_ARGS = 64
const MAX_ARG_BYTES = 4 * 1024
const MAX_CWD_BYTES = 4 * 1024
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 // 4 MB stdout+stderr cap
const SPAWN_TIMEOUT_MS = 120_000

const ALLOWED_ENV_KEYS = new Set(['SLAYZONE_PROJECT_ID', 'SLAYZONE_TASK_ID'])

const PayloadSchema = z.object({
  args: z
    .array(z.string().max(MAX_ARG_BYTES))
    .min(1)
    .max(MAX_ARGS),
  cwd: z.string().max(MAX_CWD_BYTES).optional(),
  env: z.record(z.string(), z.string().max(MAX_ARG_BYTES)).optional()
})

export function registerCliExecRoute(app: Express, _deps: RestApiDeps): void {
  const jsonParser = express.json({ limit: MAX_BODY_BYTES })

  app.post('/api/cli/exec', jsonParser, (req, res) => {
    const parsed = PayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message })
      return
    }

    const slayBin = getCliBinTarget()
    const args = parsed.data.args
    const cwd = parsed.data.cwd && parsed.data.cwd.length > 0 ? parsed.data.cwd : undefined

    // Build env: parent env minus anything the caller could try to shadow,
    // plus the whitelisted forwards. We intentionally do NOT propagate the
    // caller's PATH — host CLI must resolve against the host's PATH.
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') baseEnv[k] = v
    }
    if (parsed.data.env) {
      for (const [k, v] of Object.entries(parsed.data.env)) {
        if (ALLOWED_ENV_KEYS.has(k)) baseEnv[k] = v
      }
    }

    recordDiagnosticEvent({
      level: 'info',
      source: 'main',
      event: 'cli_proxy.exec.start',
      payload: {
        argsCount: args.length,
        firstArg: args[0] ?? null,
        hasCwd: Boolean(cwd),
        forwardedEnvKeys: Object.keys(parsed.data.env ?? {}).filter((k) => ALLOWED_ENV_KEYS.has(k))
      }
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false

    let child: ReturnType<typeof spawn>
    try {
      // `shell: true` so the Windows .cmd shim resolves through cmd.exe (node-pty
      // path is not relevant here — we want a one-shot child, not a TTY).
      child = spawn(slayBin, args, {
        cwd,
        env: baseEnv,
        shell: process.platform === 'win32',
        windowsHide: true
      })
    } catch (err) {
      recordDiagnosticEvent({
        level: 'error',
        source: 'main',
        event: 'cli_proxy.exec.spawn_failed',
        message: (err as Error).message,
        payload: { slayBin }
      })
      res.status(500).json({ ok: false, error: (err as Error).message })
      return
    }

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      if (truncated) {
        stderr +=
          (stderr.endsWith('\n') ? '' : '\n') +
          `slay-proxy: output truncated at ${MAX_OUTPUT_BYTES} bytes\n`
      }
      recordDiagnosticEvent({
        level: 'info',
        source: 'main',
        event: 'cli_proxy.exec.exit',
        payload: {
          exitCode,
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          truncated
        }
      })
      res.json({ stdout, stderr, exitCode })
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      stderr +=
        (stderr.endsWith('\n') ? '' : '\n') +
        `slay-proxy: host CLI killed after ${SPAWN_TIMEOUT_MS}ms\n`
      finish(124)
    }, SPAWN_TIMEOUT_MS)

    const onChunk = (
      buf: Buffer,
      target: 'stdout' | 'stderr'
    ): void => {
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(stdout + stderr, 'utf8')
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf
      if (target === 'stdout') stdout += slice.toString('utf8')
      else stderr += slice.toString('utf8')
      if (buf.length > remaining) truncated = true
    }

    child.stdout?.on('data', (b: Buffer) => onChunk(b, 'stdout'))
    child.stderr?.on('data', (b: Buffer) => onChunk(b, 'stderr'))

    child.once('error', (err) => {
      clearTimeout(killTimer)
      if (settled) return
      settled = true
      recordDiagnosticEvent({
        level: 'error',
        source: 'main',
        event: 'cli_proxy.exec.error',
        message: err.message,
        payload: { slayBin }
      })
      res.status(500).json({ ok: false, error: err.message })
    })

    child.once('exit', (code, signal) => {
      clearTimeout(killTimer)
      const exitCode = code ?? (signal ? 128 : 1)
      finish(exitCode)
    })
  })
}
