#!/usr/bin/env node
// Builds and launches the macOS app.
//
// The macOS project is maintained by hand rather than generated, and the React
// Native community CLI is not installed, so this drives xcodebuild directly
// instead of going through `react-native run-macos`. It is also the exact
// command to reproduce a macOS build by hand.
//
//   npm run macos --workspace @hermie/app        Debug
//   npm run macos --workspace @hermie/app -- --release

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const macosDir = join(appRoot, 'macos')
const derivedData = join(macosDir, 'build', 'DerivedData')
const configuration = process.argv.includes('--release') ? 'Release' : 'Debug'

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(join(macosDir, 'Pods'))) {
  console.log('No Pods directory yet, installing.')
  run('pod', ['install'], { cwd: macosDir })
}

run(
  'xcodebuild',
  [
    '-workspace',
    'Hermie.xcworkspace',
    '-scheme',
    'Hermie-macOS',
    '-configuration',
    configuration,
    '-derivedDataPath',
    derivedData,
    'build'
  ],
  { cwd: macosDir }
)

const app = join(derivedData, 'Build', 'Products', configuration, 'Hermie.app')
if (!existsSync(app)) {
  console.error(`Build reported success but ${app} is missing.`)
  process.exit(1)
}

if (configuration === 'Debug') {
  console.log('\nA Debug build loads its JavaScript from Metro. Start it with:')
  console.log('  npm run start --workspace @hermie/app')
}

run('open', [app])
