#!/usr/bin/env node
/**
 * Sets the version everywhere it is written down, in one go.
 *
 *   node scripts/set-version.mjs 0.2.0
 *   node scripts/set-version.mjs 0.2.0 --build 7
 *   node scripts/set-version.mjs 0.2.0 --check    # report, change nothing
 *
 * There are four places, and they drift because three of them are easy to
 * forget: the root package.json, the app's package.json, `version` in
 * app.config.ts (which is what iOS and Android ship as their marketing
 * version), and the hand-maintained macOS project, where the same number lives
 * in Info.plist as CFBundleShortVersionString — or in MARKETING_VERSION, if
 * that build setting is ever introduced.
 *
 * The build number, CFBundleVersion, is separate: it has to increase for every
 * upload, which is not the same rhythm as the marketing version. `--build`
 * sets it; leaving it out leaves it alone.
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
const buildIndex = args.indexOf('--build')
const buildNumber = buildIndex === -1 ? null : args[buildIndex + 1]
const version = args.find(argument => !argument.startsWith('--') && argument !== buildNumber)

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch> [--build <n>] [--check]')
  process.exit(2)
}
if (buildIndex !== -1 && !/^\d+$/.test(buildNumber ?? '')) {
  console.error('--build takes a whole number.')
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
edit(
  'apps/hermie/macos/Hermie-macOS/Info.plist',
  'CFBundleShortVersionString',
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${version}$2`
)

// MARKETING_VERSION is not in the project today; the macOS Info.plist carries
// the literal. If a future Xcode edit introduces the build setting, the two
// would disagree silently, so it is updated here as well when it appears.
const projectPath = 'apps/hermie/macos/Hermie.xcodeproj/project.pbxproj'
if (/MARKETING_VERSION\s*=/.test(readFileSync(resolve(repoRoot, projectPath), 'utf8'))) {
  edit(projectPath, 'MARKETING_VERSION', /MARKETING_VERSION\s*=\s*[^;]+;/g, `MARKETING_VERSION = ${version};`)
}

if (buildNumber !== null) {
  edit(
    'apps/hermie/macos/Hermie-macOS/Info.plist',
    'CFBundleVersion',
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${buildNumber}$2`
  )
  const pbxproj = readFileSync(resolve(repoRoot, projectPath), 'utf8')
  if (/CURRENT_PROJECT_VERSION\s*=/.test(pbxproj)) {
    edit(
      projectPath,
      'CURRENT_PROJECT_VERSION',
      /CURRENT_PROJECT_VERSION\s*=\s*[^;]+;/g,
      `CURRENT_PROJECT_VERSION = ${buildNumber};`
    )
  }
}

for (const change of changes) {
  console.log(change)
}

console.log('')
console.log(`Next: put a [${version}] section in CHANGELOG.md, commit, and tag v${version}.`)
console.log(`      node scripts/changelog-section.mjs ${version}   # what the release notes will say`)
console.log(`      ${relative(process.cwd(), resolve(repoRoot, 'docs/release.md'))} is the rest of it.`)
