#!/usr/bin/env node
/**
 * Sets the version everywhere it is written down, in one go.
 *
 *   node scripts/set-version.mjs 0.2.0
 *   node scripts/set-version.mjs 0.2.0 --check    # report, change nothing
 *
 * Three places, and they drift because two of them are easy to forget: the root
 * package.json, the app's package.json, and `version` in app.config.ts, which
 * is the marketing version every platform ships — iOS, Android, and the Mac,
 * which is the iOS build (ADR-0011). There used to be a fourth, and a `--build`
 * flag to go with it: the hand-maintained macOS project's Info.plist carried
 * both numbers because nothing generated them. Nothing carries them by hand any
 * more — the build number is EAS's, raised per build by `autoIncrement` on the
 * `production` profile — so there is no longer anywhere for this script to put
 * one.
 *
 * Run it from a clean tree, read the diff, then tag. docs/release.md is the
 * surrounding process.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const version = args.find(argument => !argument.startsWith('--'))

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch> [--check]')
  process.exit(2)
}

const changes = []

/**
 * Applies one replacement to one file, and fails loudly when the pattern no
 * longer matches. A version bump that silently skipped a file is exactly the
 * bug this script exists to prevent.
 */
function edit(path, description, pattern, replace) {
  const full = resolve(repoRoot, path)
  const before = readFileSync(full, 'utf8')
  const matches = before.match(pattern)
  if (!matches) {
    console.error(`${path}: could not find ${description}.`)
    console.error('The file has moved on without this script. Read it and fix the pattern.')
    process.exit(1)
  }
  const after = before.replace(pattern, replace)
  if (after === before) {
    changes.push(`unchanged  ${path}  ${description}`)
    return
  }
  if (!checkOnly) {
    writeFileSync(full, after)
  }
  const verb = checkOnly ? 'would set' : 'set      '
  changes.push(`${verb}  ${path}  ${description}: ${matches[0].trim()} -> ${after.match(pattern)[0].trim()}`)
}

edit('package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('apps/hermie/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('apps/hermie/app.config.ts', 'the Expo version', /version:\s*'[^']+'/, `version: '${version}'`)

for (const change of changes) {
  console.log(change)
}

console.log('')
console.log(`Next: put a [${version}] section in CHANGELOG.md, commit, and tag v${version}.`)
console.log(`      node scripts/changelog-section.mjs ${version}   # what the release notes will say`)
console.log(`      ${relative(process.cwd(), resolve(repoRoot, 'docs/release.md'))} is the rest of it.`)
