/**
 * Tests for buildTransportSpawn and tmuxSessionNameFor.
 * Run with: npx tsx packages/domains/terminal/src/main/transport-spawn.test.ts
 */
import { buildTransportSpawn, tmuxSessionNameFor } from './transport-spawn'
import { quoteForShell } from './shell-env'

const q = quoteForShell

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

console.log('\ntmuxSessionNameFor:')
test('plain id', () => {
  eq(tmuxSessionNameFor('abc123'), 'slz-abc123')
})
test('strips colon (pane id)', () => {
  eq(tmuxSessionNameFor('task-1:tab-2'), 'slz-task-1_tab-2')
})
test('strips dot (reserved)', () => {
  eq(tmuxSessionNameFor('a.b.c'), 'slz-a_b_c')
})
test('strips both', () => {
  eq(tmuxSessionNameFor('x:y.z'), 'slz-x_y_z')
})

console.log('\nbuildTransportSpawn — host:')
test('null context returns null', () => {
  eq(buildTransportSpawn(null, '/home/u', {}, {}, {}), null)
})
test('host type returns null', () => {
  eq(buildTransportSpawn({ type: 'host' }, '/home/u', {}, {}, {}), null)
})

console.log('\nbuildTransportSpawn — docker:')
test('basic docker exec', () => {
  const r = buildTransportSpawn(
    { type: 'docker', container: 'dev', workdir: '/app' },
    '/home/u',
    {},
    { CLAUDE_KEY: 'sekret' },
    { MCP_PORT: '7331' }
  )
  assert(r !== null, 'expected non-null')
  eq(r!.file, 'docker')
  assert(r!.args.includes('exec'), 'has exec')
  assert(r!.args.includes('-it'), 'has -it')
  assert(r!.args.includes('CLAUDE_KEY=sekret'), 'forwards adapter env')
  assert(r!.args.includes('MCP_PORT=7331'), 'forwards mcp env')
  assert(r!.args.includes('SLAYZONE_MCP_HOST=host.docker.internal'), 'rewrites mcp host')
  assert(r!.args.includes('-w'), 'has -w')
  assert(r!.args.includes('/app'), 'has workdir')
  assert(r!.args.includes('dev'), 'has container')
})

console.log('\nbuildTransportSpawn — ssh (no sessionId):')
test('falls back to raw script when sessionId omitted', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'user@host', workdir: '/repo' },
    '/home/u',
    {},
    {},
    {}
  )
  assert(r !== null, 'expected non-null')
  assert(/(^|[\\/])ssh(\.exe)?$/i.test(r!.file), `expected ssh executable, got: ${r!.file}`)
  const last = r!.args[r!.args.length - 1]
  assert(!last.startsWith('tmux'), 'no tmux wrap without sessionId')
  assert(last.includes(`cd ${q('/repo')}`), 'has cd workdir')
  assert(last.includes(`exec ${q('/bin/bash')} -i -l`), 'has exec shell')
})

console.log('\nbuildTransportSpawn — ssh (with sessionId, tmux wrap):')
test('wraps inner script in tmux new-session -A -s slz-<id>', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'user@host', workdir: '/repo' },
    '/home/u',
    {},
    { CLAUDE_KEY: 'k' },
    {},
    'sess-1'
  )
  assert(r !== null, 'expected non-null')
  assert(/(^|[\\/])ssh(\.exe)?$/i.test(r!.file), `expected ssh executable, got: ${r!.file}`)
  const last = r!.args[r!.args.length - 1]
  assert(last.startsWith('tmux new-session -A -s '), `expected tmux prefix, got: ${last}`)
  assert(last.includes(q('slz-sess-1')), 'has tmux session name')
  assert(last.includes(`cd ${q('/repo')}`), 'inner script has cd')
  assert(last.includes(`export CLAUDE_KEY=${q('k')}`), 'inner script has env export')
  assert(last.includes(`exec ${q('/bin/bash')} -i -l`), 'inner script execs shell')
})

test('pane sessionId (colon) sanitized in tmux name', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'h' },
    '/h',
    {},
    {},
    {},
    'task-1:tab-2'
  )
  const last = r!.args[r!.args.length - 1]
  assert(last.includes(q('slz-task-1_tab-2')), `expected sanitized name, got: ${last}`)
})

test('mcp port adds -R reverse forward + SLAYZONE_MCP_HOST=localhost', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'h' },
    '/h',
    {},
    {},
    {},
    'sess-x',
    7331
  )
  assert(r!.args.includes('-R'), 'has -R flag')
  // Tunnel target is explicitly 127.0.0.1 (not `localhost`) so Windows OpenSSH
  // does not race to IPv6 ::1 against the IPv4-only host server.
  assert(r!.args.includes('7331:127.0.0.1:7331'), 'has port forward arg with explicit IPv4')
  const last = r!.args[r!.args.length - 1]
  assert(last.includes('export SLAYZONE_MCP_HOST=localhost'), 'inner script exports MCP host')
})

test('inner script prepends ~/.slayzone/bin to PATH so slay-proxy shadows pre-existing slay', () => {
  const r = buildTransportSpawn({ type: 'ssh', target: 'h' }, '/h', {}, {}, {}, 'sess-pp')
  const last = r!.args[r!.args.length - 1]
  // quoteForShell wraps the inner script in double quotes and escapes inner
  // `"` as `""`, so we assert on the shape that survives wrapping.
  assert(
    /export PATH=("|"")\$HOME\/\.slayzone\/bin:\$PATH("|"")/.test(last),
    `inner script must prepend ~/.slayzone/bin to PATH, got: ${last}`
  )
})

test('custom shell honored', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'h', shell: '/usr/bin/zsh' },
    '/h',
    {},
    {},
    {},
    's'
  )
  const last = r!.args[r!.args.length - 1]
  assert(last.includes(`exec ${q('/usr/bin/zsh')} -i -l`), `expected zsh exec, got: ${last}`)
})

test('workdir fallback uses cwd when ctx.workdir absent', () => {
  const r = buildTransportSpawn(
    { type: 'ssh', target: 'h' },
    '/fallback/path',
    {},
    {},
    {},
    's'
  )
  const last = r!.args[r!.args.length - 1]
  assert(last.includes(`cd ${q('/fallback/path')}`), 'uses cwd as fallback workdir')
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
