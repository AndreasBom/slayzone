/**
 * Tests for runGit transport-aware command builder + DB lookup.
 * Run with: npx tsx packages/domains/worktrees/src/main/run-git.test.ts
 */
import {
  buildGitCommand,
  posixQuote,
  resolveProjectExecutionContext,
  resolveSshExecutable,
  type GitExecutionContext
} from './run-git'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

console.log('\nposixQuote:')
test('plain word → single-quoted', () => {
  eq(posixQuote('status'), "'status'")
})
test('empty string', () => {
  eq(posixQuote(''), "''")
})
test('embedded space', () => {
  eq(posixQuote('foo bar'), "'foo bar'")
})
test('embedded single quote escapes', () => {
  eq(posixQuote("o'reilly"), `'o'\\''reilly'`)
})
test('embedded double-quote left alone (single-quotes are literal)', () => {
  eq(posixQuote('a"b'), `'a"b'`)
})
test('embedded dollar-sign left alone', () => {
  eq(posixQuote('$HOME'), "'$HOME'")
})

console.log('\nbuildGitCommand — host:')
test('null context → git locally', () => {
  const cmd = buildGitCommand(null, ['status', '--porcelain'], { cwd: '/r' })
  eq(cmd.file, 'git')
  eq(cmd.args, ['status', '--porcelain'])
  eq(cmd.cwd, '/r')
})
test('host context → identical to null', () => {
  const cmd = buildGitCommand({ type: 'host' }, ['log', '-1'])
  eq(cmd.file, 'git')
  eq(cmd.args, ['log', '-1'])
  eq(cmd.cwd, undefined)
})

console.log('\nbuildGitCommand — ssh:')
test('ssh context wraps in ssh + git -C', () => {
  const ctx: GitExecutionContext = {
    type: 'ssh',
    target: 'user@dev',
    workdir: '/home/u/repo'
  }
  const cmd = buildGitCommand(ctx, ['status', '--porcelain'])
  assert(/(^|[\\/])ssh(\.exe)?$/i.test(cmd.file), `expected ssh executable, got: ${cmd.file}`)
  assert(cmd.args.includes('-o') && cmd.args.includes('BatchMode=yes'), 'has BatchMode=yes')
  assert(
    cmd.args.includes('-o') && cmd.args.includes('ConnectTimeout=10'),
    'has ConnectTimeout=10'
  )
  assert(cmd.args.includes('--'), 'has -- separator')
  assert(cmd.args.includes('user@dev'), 'has ssh target')
  const remoteCmd = cmd.args[cmd.args.length - 1]
  eq(remoteCmd, `git -C '/home/u/repo' 'status' '--porcelain'`)
})

test('cwd opt overrides executionContext.workdir', () => {
  const ctx: GitExecutionContext = {
    type: 'ssh',
    target: 'host',
    workdir: '/wrong'
  }
  const cmd = buildGitCommand(ctx, ['log'], { cwd: '/right' })
  const remoteCmd = cmd.args[cmd.args.length - 1]
  eq(remoteCmd, `git -C '/right' 'log'`)
})

test('ssh w/o cwd or workdir omits -C', () => {
  const cmd = buildGitCommand({ type: 'ssh', target: 'host' }, ['rev-parse', '--is-inside-work-tree'])
  const remoteCmd = cmd.args[cmd.args.length - 1]
  eq(remoteCmd, `git 'rev-parse' '--is-inside-work-tree'`)
})

test('args with shell metacharacters are quoted (no injection)', () => {
  const ctx: GitExecutionContext = { type: 'ssh', target: 'host' }
  const cmd = buildGitCommand(ctx, ['log', '--pretty=format:%H $(touch /tmp/pwn)'])
  const remoteCmd = cmd.args[cmd.args.length - 1]
  // The $(…) must be inside a single-quoted string so the remote shell never
  // executes it as a command substitution.
  assert(
    remoteCmd.includes(`'--pretty=format:%H $(touch /tmp/pwn)'`),
    `expected dangerous arg single-quoted, got: ${remoteCmd}`
  )
})

test('args containing single quotes are escaped (' + `'\\''` + ' POSIX trick)', () => {
  const ctx: GitExecutionContext = { type: 'ssh', target: 'host' }
  const cmd = buildGitCommand(ctx, ['commit', '-m', "fix: it's broken"])
  const remoteCmd = cmd.args[cmd.args.length - 1]
  eq(remoteCmd, `git 'commit' '-m' 'fix: it'\\''s broken'`)
})

console.log('\nresolveSshExecutable:')
test('SLAYZONE_SSH_PATH override honoured when file exists', () => {
  // The function only uses the override if existsSync returns true. Easy
  // existing path: process.execPath itself.
  const original = process.env.SLAYZONE_SSH_PATH
  process.env.SLAYZONE_SSH_PATH = process.execPath
  try {
    eq(resolveSshExecutable(), process.execPath)
  } finally {
    if (original === undefined) delete process.env.SLAYZONE_SSH_PATH
    else process.env.SLAYZONE_SSH_PATH = original
  }
})

test('returns ssh executable on the current platform', () => {
  const original = process.env.SLAYZONE_SSH_PATH
  delete process.env.SLAYZONE_SSH_PATH
  try {
    const r = resolveSshExecutable()
    assert(/(^|[\\/])ssh(\.exe)?$/i.test(r), `expected ssh-like path, got: ${r}`)
  } finally {
    if (original !== undefined) process.env.SLAYZONE_SSH_PATH = original
  }
})

console.log('\nresolveProjectExecutionContext:')
function fakeDb(rows: Record<string, unknown>): {
  prepare: (sql: string) => { get: (id: string) => unknown }
} {
  return {
    prepare: (_sql: string) => ({
      get: (id: string) => (id in rows ? { execution_context: rows[id] } : undefined)
    })
  }
}

test('missing row → null', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = resolveProjectExecutionContext(fakeDb({}) as any, 'unknown')
  eq(ctx, null)
})

test('null execution_context → null', () => {
  const ctx = resolveProjectExecutionContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb({ p: null }) as any,
    'p'
  )
  eq(ctx, null)
})

test('host JSON parses', () => {
  const ctx = resolveProjectExecutionContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb({ p: JSON.stringify({ type: 'host' }) }) as any,
    'p'
  )
  eq(ctx, { type: 'host' })
})

test('ssh JSON parses with workdir + shell', () => {
  const ctx = resolveProjectExecutionContext(
    fakeDb({
      p: JSON.stringify({
        type: 'ssh',
        target: 'carelogic@dev',
        workdir: '/home/u/repo',
        shell: '/bin/zsh'
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    'p'
  )
  eq(ctx, {
    type: 'ssh',
    target: 'carelogic@dev',
    workdir: '/home/u/repo',
    shell: '/bin/zsh'
  })
})

test('ssh without target rejected', () => {
  const ctx = resolveProjectExecutionContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb({ p: JSON.stringify({ type: 'ssh' }) }) as any,
    'p'
  )
  eq(ctx, null)
})

test('malformed JSON degrades to null (does not throw)', () => {
  const ctx = resolveProjectExecutionContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb({ p: 'not-json' }) as any,
    'p'
  )
  eq(ctx, null)
})

test('unknown context type → null', () => {
  const ctx = resolveProjectExecutionContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb({ p: JSON.stringify({ type: 'docker', container: 'dev' }) }) as any,
    'p'
  )
  // Phase 2 step 1 explicitly scopes to host + ssh. Docker support is
  // deferred — the resolver should refuse rather than guess.
  eq(ctx, null)
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
