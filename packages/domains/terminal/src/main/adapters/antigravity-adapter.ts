import {
  defaultEncodeSubmit,
  type TerminalAdapter,
  type PromptInfo,
  type ActivityState,
  type ErrorInfo,
  type ValidationResult
} from './types'
import { whichBinary, validateShellEnv } from '../shell-env'

/**
 * Adapter for Google Antigravity CLI — the successor to Gemini CLI (Gemini CLI
 * stops serving free/Pro/Ultra requests 2026-06-18). Go-based agentic CLI;
 * detection heuristics mirror the Gemini adapter and should be tuned once the
 * binary's real output is observed.
 */
export class AntigravityAdapter implements TerminalAdapter {
  readonly mode = 'antigravity' as const
  // TUI redraws in bursts; short idle timeout to detect when response is done
  readonly idleTimeoutMs = 2500
  // detectActivity is coarse (any chunk > 50 chars → working). Stay output-
  // driven so small redraw chunks during real work still pin the idle clock
  // open — otherwise it would flip to idle mid-response.
  readonly transitionOnInput = false
  // Heavy CLI bundle; allow generous startup window for first output.
  readonly startupTimeoutMs = 20_000

  encodeSubmit = defaultEncodeSubmit

  private static stripAnsi(data: string): string {
    return data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
      .replace(/\x1b[()][AB012]/g, '') // Character set
  }

  detectActivity(data: string, _current: ActivityState): ActivityState | null {
    const stripped = AntigravityAdapter.stripAnsi(data).trimStart()
    if (stripped.length > 50) return 'working'
    return null
  }

  detectError(data: string): ErrorInfo | null {
    const stripped = AntigravityAdapter.stripAnsi(data)

    if (/ANTIGRAVITY_TOKEN environment variable not found|not (?:logged in|authenticated)/i.test(stripped)) {
      return {
        code: 'MISSING_API_KEY',
        message: 'Antigravity not authenticated (ANTIGRAVITY_TOKEN not set / signed out)',
        recoverable: false
      }
    }

    if (
      /429|Too Many Requests|exceeded your current quota|Resource has been exhausted/i.test(
        stripped
      )
    ) {
      return {
        code: 'RATE_LIMIT',
        message: 'API rate limit exceeded',
        recoverable: true
      }
    }

    return null
  }

  async validate(): Promise<ValidationResult[]> {
    const [shell, found] = await Promise.all([validateShellEnv(), whichBinary('agy')])
    const results: ValidationResult[] = []
    if (!shell.ok) results.push(shell)
    results.push({
      check: 'Binary found',
      ok: !!found,
      detail: found ?? 'agy not found in PATH',
      fix: found ? undefined : 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    })
    return results
  }

  detectPrompt(data: string): PromptInfo | null {
    const stripped = AntigravityAdapter.stripAnsi(data)

    if (/Approve\?\s*\(y\/n(\/always)?\)/i.test(stripped)) {
      return {
        type: 'permission',
        text: data,
        position: 0
      }
    }

    return null
  }

  detectConversationId(data: string): string | null {
    const stripped = AntigravityAdapter.stripAnsi(data)
    // Try labeled match first
    const labeled = stripped.match(
      /session\s*id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im
    )
    if (labeled) return labeled[1]
    // Last resort: any UUID in the output
    const bare = stripped.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    return bare ? bare[1] : null
  }
}
