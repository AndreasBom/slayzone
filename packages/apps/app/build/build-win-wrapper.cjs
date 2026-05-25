#!/usr/bin/env node
// Wraps `electron-builder --win` to work around two pnpm/electron-builder
// frictions that only bite on Windows:
//
// 1. `posix` is a Unix-only native module (#include <unistd.h>). Even though
//    it's in optionalDependencies, electron-rebuild tries to compile it
//    from source via node-gyp on Windows and fails. We strip it from
//    package.json for the duration of the build.
//
// 2. `node_modules/@slayzone/*` are pnpm workspace symlinks pointing at
//    packages/domains/*. electron-builder walks them and aborts with
//    "package.json must be under packages/apps/app/". The bundled
//    `out/main/index.js` already has all workspace code rolled in via
//    vite, so the symlinks are runtime-redundant during packaging.
//
// Restore happens in `finally` so an aborted/failed build never leaves the
// repo mutated. The @slayzone symlinks are recreated by `pnpm install`.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const pkgPath = path.join(appRoot, 'package.json')
const original = fs.readFileSync(pkgPath, 'utf-8')
const trailingNewline = original.endsWith('\n') ? '\n' : ''

const stripped = JSON.parse(original)
if (stripped.optionalDependencies?.posix) {
  delete stripped.optionalDependencies.posix
}

const slayzoneDir = path.join(appRoot, 'node_modules', '@slayzone')
const slayzoneBackup = path.join(appRoot, 'node_modules', '.@slayzone.bak')
let movedSymlinks = false

const electronBuilderBin = path.join(
  appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.CMD' : 'electron-builder'
)

let exitCode = 1
try {
  fs.writeFileSync(pkgPath, JSON.stringify(stripped, null, 2) + trailingNewline)

  if (fs.existsSync(slayzoneDir)) {
    fs.renameSync(slayzoneDir, slayzoneBackup)
    movedSymlinks = true
  }

  const result = spawnSync(electronBuilderBin, ['--win', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  })
  exitCode = result.status ?? 1
} finally {
  fs.writeFileSync(pkgPath, original)
  if (movedSymlinks && fs.existsSync(slayzoneBackup)) {
    if (fs.existsSync(slayzoneDir)) {
      fs.rmSync(slayzoneDir, { recursive: true, force: true })
    }
    fs.renameSync(slayzoneBackup, slayzoneDir)
  }
}

process.exit(exitCode)
