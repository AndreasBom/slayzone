/**
 * Tests for AntigravityAdapter detection methods
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/antigravity-adapter.test.ts
 */
import { AntigravityAdapter } from './antigravity-adapter'

const adapter = new AntigravityAdapter()

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    process.exitCode = 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

console.log('\nAntigravityAdapter.detectConversationId\n')

test('extracts UUID from box-drawing session output', () => {
  const data = `╭───────────────────────────────────────────────────────────╮
│                                                                               │
│  Session Stats                                                                │
│                                                                               │
│  Session ID:                 410fe90d-0542-49ad-8003-d092114063f6             │
│  Tool Calls:                 45                                              │
│                                                                               │
╰───────────────────────────────────────────────────────────╯`
  expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
})

test('extracts UUID from plain Session ID: line', () => {
  expect(adapter.detectConversationId('Session ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  )
})

test('falls back to bare UUID when label is mangled', () => {
  const data = '\rSession ID:\r\n410fe90d-0542-49ad-8003-d092114063f6\r\n'
  expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
})

test('returns null when no session ID present', () => {
  expect(adapter.detectConversationId('Tool Calls: 45\nSuccess Rate: 95.6%\n')).toBe(null)
})

test('handles ANSI codes in session line', () => {
  const data = '\x1b[1mSession ID:\x1b[0m  410fe90d-0542-49ad-8003-d092114063f6'
  expect(adapter.detectConversationId(data)).toBe('410fe90d-0542-49ad-8003-d092114063f6')
})

console.log('\nAntigravityAdapter.detectError\n')

test('detects missing auth (ANTIGRAVITY_TOKEN)', () => {
  const result = adapter.detectError('ANTIGRAVITY_TOKEN environment variable not found')
  expect(result?.code).toBe('MISSING_API_KEY')
})

test('detects missing auth (signed out)', () => {
  const result = adapter.detectError('Error: not authenticated. Run antigravity login.')
  expect(result?.code).toBe('MISSING_API_KEY')
})

test('detects rate limit', () => {
  const result = adapter.detectError('429 Too Many Requests')
  expect(result?.code).toBe('RATE_LIMIT')
})

test('returns null for normal output', () => {
  expect(adapter.detectError('Some normal output')).toBe(null)
})

console.log('\nDone\n')
