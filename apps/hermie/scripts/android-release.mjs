#!/usr/bin/env node
// Builds the Android release artefacts and says where they landed.
//
// The app bundle is what Play takes; the APK is what a person sideloads. Both
// come out of one Gradle invocation, so building them together costs barely more
// than building either.
//
//   npm run android:release              prebuild if needed, then bundle + assemble
//   npm run android:release -- --clean   prebuild --clean first, always
//   npm run android:release -- --apk     the APK only
//   npm run android:release -- --aab     the app bundle only
//
// Signing is not this script's business and deliberately so. The four
// HERMIE_UPLOAD_* values reach Gradle from `~/.gradle/gradle.properties` or from
// the environment, and `plugins/with-android-release-signing.js` decides what to
// do with them — the upload key when all four are there, the template's debug key
// otherwise. Nothing is read here, so nothing can be printed or written here.
// See docs/release.md.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')
const androidDir = join(appRoot, 'android')

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const onlyApk = args.includes('--apk')
const onlyAab = args.includes('--aab')

if (onlyApk && onlyAab) {
  console.error('--apk and --aab are the two halves of the default; pass neither to get both.')
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// `android/` is a prebuild output and gitignored, so a clean checkout has none.
// `--clean` regenerates it even when it is there, which is what picks up a
// changed app.config.ts or config plugin.
if (clean || !existsSync(join(androidDir, 'gradlew'))) {
  const reason = clean ? '--clean given' : 'no android/ yet'
  console.log(`Generating the native project (${reason}).`)
  run('npx', ['expo', 'prebuild', '--platform', 'android', ...(clean ? ['--clean'] : [])], { cwd: appRoot })
}

if (!process.env.JAVA_HOME) {
  // Not fatal: Gradle may still find a JDK. But on this project it is JDK 17, and
  // a wrong one fails much later with a message about nothing in particular.
  console.log('JAVA_HOME is not set. Android builds here need JDK 17 — see CONTRIBUTING.md.')
}

// bundleRelease before assembleRelease so the slower, more important artefact
// fails first if it is going to.
const tasks = onlyApk ? ['assembleRelease'] : onlyAab ? ['bundleRelease'] : ['bundleRelease', 'assembleRelease']
run('./gradlew', [...tasks, '--no-daemon'], { cwd: androidDir })

const outputs = [
  ['app bundle', join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')],
  ['APK', join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')]
]

console.log('\nArtefacts:')
let missing = false
for (const [what, path] of outputs) {
  if (!existsSync(path)) {
    if ((onlyApk && what === 'app bundle') || (onlyAab && what === 'APK')) {
      continue
    }
    console.log(`  ${what}: NOT PRODUCED at ${relative(repoRoot, path)}`)
    missing = true
    continue
  }
  const megabytes = (statSync(path).size / 1024 / 1024).toFixed(1)
  console.log(`  ${what}: ${relative(repoRoot, path)} (${megabytes} MB)`)
}

if (missing) {
  process.exit(1)
}

console.log(
  '\nWhich key signed these is in the build log above, on the line beginning "hermie:".' +
    '\nCheck it before uploading: apksigner verify --print-certs on the APK, keytool -printcert -jarfile on the bundle.'
)
