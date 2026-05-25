/**
 * SlayZone instance id — a stable per-install UUID used to tag remote tmux
 * sessions (via `@slz-instance-id` option) so multiple SlayZone instances
 * sharing the same SSH target can attribute session ownership correctly.
 *
 * Persistence:
 *   - File at `${userData}/.slayzone-instance-id` (UUID, one line, no
 *     trailing newline policy).
 *   - Created on first call if missing.
 *   - Survives `pnpm clean` because userData lives outside the working
 *     tree (`%APPDATA%/Roaming/slayzone` on Windows,
 *     `~/Library/Application Support/SlayZone` on macOS).
 *
 * Overrides:
 *   - `SLAYZONE_INSTANCE_ID` env var, when set, overrides the file —
 *     dev-only knob used by Playwright e2e to make instance-attribution
 *     deterministic across test runs.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

let cached: string | null = null

function resolveInstanceIdFilePath(): string {
  const dataDir = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  return path.join(dataDir, '.slayzone-instance-id')
}

export function getSlayzoneInstanceId(): string {
  if (cached) return cached

  const override = process.env.SLAYZONE_INSTANCE_ID
  if (override && override.trim().length > 0) {
    cached = override.trim()
    return cached
  }

  const filePath = resolveInstanceIdFilePath()
  try {
    const existing = fs.readFileSync(filePath, 'utf-8').trim()
    if (existing.length > 0) {
      cached = existing
      return cached
    }
  } catch {
    /* missing → create */
  }

  const id = randomUUID()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, id, 'utf-8')
  } catch {
    /* writing failed (read-only fs, etc.) — fall back to in-memory id */
  }
  cached = id
  return id
}
