/**
 * Tests for ssh-fs path-traversal safety.
 * Run with: npx tsx packages/domains/file-editor/src/main/ssh-fs.test.ts
 *
 * Network-side functions (sshReadDir / sshReadFile) are not exercised here —
 * they spawn ssh and need an integration setup behind SLAYZONE_E2E_SSH=1.
 */
import { joinRemotePath } from './ssh-fs'

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

function eq<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function throws(fn: () => void, label: string): void {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  if (!threw) throw new Error(`${label}: expected throw, none occurred`)
}

console.log('\njoinRemotePath:')

test('empty dirPath → root unchanged', () => {
  eq(joinRemotePath('/home/u/repo', ''), '/home/u/repo')
})

test('basic relative join', () => {
  eq(joinRemotePath('/home/u/repo', 'src/main'), '/home/u/repo/src/main')
})

test('leading slash stripped', () => {
  eq(joinRemotePath('/home/u/repo', '/src/main'), '/home/u/repo/src/main')
})

test('trailing slash stripped', () => {
  eq(joinRemotePath('/home/u/repo', 'src/main/'), '/home/u/repo/src/main')
})

test('root trailing slash normalized', () => {
  eq(joinRemotePath('/home/u/repo/', 'src'), '/home/u/repo/src')
})

test('backslash converted to forward slash', () => {
  eq(joinRemotePath('/home/u/repo', 'src\\main\\file.ts'), '/home/u/repo/src/main/file.ts')
})

test('traversal via .. rejected', () => {
  throws(() => joinRemotePath('/home/u/repo', '../etc/passwd'), '..')
})

test('embedded .. rejected', () => {
  throws(() => joinRemotePath('/home/u/repo', 'src/../../etc/passwd'), 'embedded ..')
})

test('. segment rejected (avoid ambiguity)', () => {
  throws(() => joinRemotePath('/home/u/repo', './src'), '.')
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
