import { exec } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { getSlayzoneHomeDir, writeFileIfChanged } from '@slayzone/platform'
// Vite resolves `?raw` to the file contents as a string at build time. Static
// import (not dynamic) so the script content lands in this module's chunk and
// no runtime file lookup is required in the packaged app.
// @ts-expect-error -- ?raw is a Vite runtime feature, not a typed module.
import codexWrapperSource from '@slayzone/hooks/codex-wrapper.sh?raw'

const execP = promisify(exec)

// Codex `hooks` subsystem (formerly `codex_hooks`) is stable + default-enabled
// from 0.129. Below that, --enable hooks may not exist or behave differently.
const MIN_CODEX_VERSION = { major: 0, minor: 129 }

export interface InstallCodexWrapperOpts {
  /** Override script source. Defaults to the bundled `codex-wrapper.sh`. Tests inject a fixture. */
  source?: string
  /** Override target path. Defaults to `~/.slayzone/bin/codex`. */
  targetPath?: string
  /** Skip the `codex --version` probe (tests). */
  skipVersionProbe?: boolean
}

export interface InstallCodexWrapperResult {
  path: string
  changed: boolean
  /** Detected codex version string, or null if probe failed/skipped. */
  detectedVersion: string | null
  /** True iff detected version is at or above MIN_CODEX_VERSION. Null if probe skipped/failed. */
  versionOk: boolean | null
}

/**
 * Write the Codex PATH-shadow wrapper to `~/.slayzone/bin/codex` with mode 0755.
 * Idempotent: re-runs are no-ops when content is unchanged.
 *
 * Also probes `codex --version` and warns (does NOT refuse) when below
 * MIN_CODEX_VERSION — the wrapper still installs so users get Stop events via
 * the legacy notify=[...] callback even on older codex.
 */
export async function installCodexWrapper(
  opts: InstallCodexWrapperOpts = {},
): Promise<InstallCodexWrapperResult> {
  const target = opts.targetPath ?? path.join(getSlayzoneHomeDir(), 'bin', 'codex')
  const source =
    opts.source ?? (typeof codexWrapperSource === 'string' ? codexWrapperSource : String(codexWrapperSource))
  const changed = await writeFileIfChanged(target, source, 0o755)

  let detectedVersion: string | null = null
  let versionOk: boolean | null = null
  if (!opts.skipVersionProbe) {
    const probed = await probeCodexVersion()
    detectedVersion = probed?.raw ?? null
    if (probed) {
      versionOk = isAtLeast(probed, MIN_CODEX_VERSION)
      if (!versionOk) {
        console.warn(
          `[agent-hooks] codex ${probed.raw} detected; hooks subsystem is stable in ≥${MIN_CODEX_VERSION.major}.${MIN_CODEX_VERSION.minor}. ` +
            `Start/PermissionRequest events may not fire reliably on this version.`,
        )
      }
    }
  }

  return { path: target, changed, detectedVersion, versionOk }
}

interface ParsedVersion {
  major: number
  minor: number
  raw: string
}

async function probeCodexVersion(): Promise<ParsedVersion | null> {
  try {
    // Skip our own wrapper to avoid infinite loop if it's already on PATH.
    const { stdout } = await execP('codex --version', {
      timeout: 3000,
      env: { ...process.env, PATH: stripSlayzoneBin(process.env.PATH ?? '') },
    })
    return parseCodexVersion(stdout.trim())
  } catch {
    return null
  }
}

function stripSlayzoneBin(pathVar: string): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const home = getSlayzoneHomeDir()
  const ours = path.join(home, 'bin')
  return pathVar
    .split(sep)
    .filter((p) => p !== ours)
    .join(sep)
}

/** Parses "codex 0.131.0" / "0.129.0-alpha" / "codex-cli 1.2.3". Returns null on unparseable. */
export function parseCodexVersion(raw: string): ParsedVersion | null {
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), raw }
}

function isAtLeast(v: ParsedVersion, min: { major: number; minor: number }): boolean {
  if (v.major !== min.major) return v.major > min.major
  return v.minor >= min.minor
}
