/**
 * Tests for probeRepo. Run with:
 *   npx tsx packages/domains/worktrees/src/main/probe-repo.test.ts
 *
 * Avoids spinning a real ssh + git: stubs `SLAYZONE_SSH_PATH` to a binary
 * with deterministic exit behaviour. The host path uses a tmp dir with /
 * without `.git` to drive `git rev-parse --is-inside-work-tree`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, platform } from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { probeRepo } from './probe-repo'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.stack ?? e.message : e}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, label?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

interface FakeDb {
  prepare: (sql: string) => { get: (id: string) => unknown }
}

function fakeDb(projects: Record<string, { path: string | null; execution_context?: string }>): FakeDb {
  return {
    prepare(sql: string) {
      return {
        get(id: string): unknown {
          const row = projects[id]
          if (!row) return undefined
          // Mirror both columns the real schema exposes — probeRepo issues
          // one SELECT for `path`, resolveProjectExecutionContext issues
          // another for `execution_context`.
          if (sql.includes('SELECT path FROM projects')) {
            return { path: row.path }
          }
          if (sql.includes('SELECT execution_context FROM projects')) {
            return { execution_context: row.execution_context ?? null }
          }
          throw new Error(`unexpected SQL: ${sql}`)
        }
      }
    }
  }
}

console.log('\nprobeRepo — host:')

await test('missing project row → not a repo, no error', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await probeRepo(fakeDb({}) as any, 'nope')
  eq(r.isGitRepo, false)
  eq(r.path, null)
  eq(r.executionContextType, 'host')
  eq(r.error, undefined)
})

await test('row with null path → not a repo', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await probeRepo(fakeDb({ p: { path: null } }) as any, 'p')
  eq(r.isGitRepo, false)
  eq(r.path, null)
  eq(r.executionContextType, 'host')
})

await test('host repo with .git dir → isGitRepo true', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'slz-probe-host-'))
  try {
    // Init a real repo so `git rev-parse --is-inside-work-tree` succeeds.
    execFileSync('git', ['init', '-q'], { cwd: tmp })
    const r = await probeRepo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeDb({ p: { path: tmp } }) as any,
      'p'
    )
    eq(r.isGitRepo, true)
    eq(r.path, tmp)
    eq(r.executionContextType, 'host')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('host non-repo path → isGitRepo false', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'slz-probe-nonrepo-'))
  try {
    const r = await probeRepo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeDb({ p: { path: tmp } }) as any,
      'p'
    )
    eq(r.isGitRepo, false)
    eq(r.path, tmp)
    eq(r.executionContextType, 'host')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

console.log('\nprobeRepo — ssh:')

/**
 * Build a stub "ssh" that simply runs the rest of the cmdline locally,
 * stripping the ssh flags so `git rev-parse --is-inside-work-tree`
 * actually executes. Returns the path to the stub script (executable).
 *
 * Behaviour:
 *   stub-ssh <flags...> -- <target> <remoteCmd>  →  sh -c <remoteCmd>
 */
function makeStubSsh(opts: { failTransport?: boolean } = {}): { sshPath: string; cleanup: () => void } {
  const isWin = platform() === 'win32'
  const tmp = mkdtempSync(path.join(tmpdir(), 'slz-stub-ssh-'))
  if (isWin) {
    const sshPath = path.join(tmp, 'stub-ssh.cmd')
    if (opts.failTransport) {
      writeFileSync(sshPath, '@echo ssh: transport error 1>&2\r\nexit /b 255\r\n')
    } else {
      // Re-execute the last arg via bash from git-for-windows so the POSIX
      // quoting probeRepo emits parses correctly. CI machines without
      // git-for-windows skip this branch via the file-existence guard below.
      writeFileSync(
        sshPath,
        '@echo off\r\n' +
          ':loop\r\n' +
          'if "%~1"=="--" goto found\r\n' +
          'shift\r\n' +
          'if "%~1"=="" goto fail\r\n' +
          'goto loop\r\n' +
          ':found\r\n' +
          'shift\r\n' +
          'shift\r\n' +
          'bash -c "%~1"\r\n' +
          'goto :eof\r\n' +
          ':fail\r\n' +
          'echo stub-ssh: did not find -- in args 1>&2\r\n' +
          'exit /b 1\r\n'
      )
    }
    return { sshPath, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
  }
  const sshPath = path.join(tmp, 'stub-ssh')
  if (opts.failTransport) {
    writeFileSync(sshPath, '#!/bin/sh\necho "ssh: transport error" >&2\nexit 255\n', { mode: 0o755 })
  } else {
    writeFileSync(
      sshPath,
      '#!/bin/sh\n' +
        '# strip ssh flags up to the literal `--`, then drop target, then exec\n' +
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
        'if [ "$1" != "--" ]; then echo "stub-ssh: missing --" >&2; exit 1; fi\n' +
        'shift; shift\n' +
        'sh -c "$1"\n',
      { mode: 0o755 }
    )
  }
  return { sshPath, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

await test('ssh repo: stub ssh re-runs locally, repo detected', async () => {
  // Skip on Windows: Node 20.12.2+ refuses to spawn .cmd files without
  // shell:true (CVE-2024-27980). exec-async uses bare spawn, so a stub
  // .cmd shim hits EINVAL before the test runs. The host coverage above
  // exercises the core probe logic; integration testing the ssh wrapper
  // belongs behind SLAYZONE_E2E_SSH=1 against a real sshd anyway.
  if (platform() === 'win32') {
    console.log('    (skipped on win32: spawn(.cmd) gated by CVE-2024-27980)')
    return
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'slz-probe-ssh-'))
  const { sshPath, cleanup } = makeStubSsh()
  const originalSshPath = process.env.SLAYZONE_SSH_PATH
  process.env.SLAYZONE_SSH_PATH = sshPath
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp })
    const db = fakeDb({
      p: {
        path: tmp,
        execution_context: JSON.stringify({ type: 'ssh', target: 'fake-host', workdir: tmp })
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await probeRepo(db as any, 'p')
    eq(r.isGitRepo, true, 'isGitRepo')
    eq(r.executionContextType, 'ssh')
    eq(r.error, undefined)
  } finally {
    if (originalSshPath === undefined) delete process.env.SLAYZONE_SSH_PATH
    else process.env.SLAYZONE_SSH_PATH = originalSshPath
    cleanup()
    rmSync(tmp, { recursive: true, force: true })
  }
})

await test('ssh non-repo: stub ssh runs git, gets non-zero exit, isGitRepo false (no transport error)', async () => {
  if (platform() === 'win32') {
    console.log('    (skipped on win32: spawn(.cmd) gated by CVE-2024-27980)')
    return
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'slz-probe-ssh-nonrepo-'))
  // Deliberately NOT a git repo.
  mkdirSync(path.join(tmp, 'plain'), { recursive: true })
  const { sshPath, cleanup } = makeStubSsh()
  const originalSshPath = process.env.SLAYZONE_SSH_PATH
  process.env.SLAYZONE_SSH_PATH = sshPath
  try {
    const db = fakeDb({
      p: {
        path: path.join(tmp, 'plain'),
        execution_context: JSON.stringify({ type: 'ssh', target: 'fake-host' })
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await probeRepo(db as any, 'p')
    eq(r.isGitRepo, false)
    eq(r.executionContextType, 'ssh')
    // git exited non-zero, but the transport (ssh) succeeded — `error` MUST
    // be undefined so the UI shows "not a repo" rather than "unreachable".
    eq(r.error, undefined)
  } finally {
    if (originalSshPath === undefined) delete process.env.SLAYZONE_SSH_PATH
    else process.env.SLAYZONE_SSH_PATH = originalSshPath
    cleanup()
    rmSync(tmp, { recursive: true, force: true })
  }
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
