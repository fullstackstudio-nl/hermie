#!/usr/bin/env node
/**
 * The App Store screenshot set, from iOS simulators running this app against
 * `packages/fake-gateway`.
 *
 *   npm run screenshots:ios              # walk the whole set, pausing per scene
 *   npm run screenshots:ios -- --device ipad13
 *   npm run screenshots:ios -- --scheme dark
 *   npm run screenshots:ios -- --list    # print the table and exit
 *   node scripts/screenshots-ios.mjs capture <udid> <out.png> <width>x<height>
 *
 * ## Why this is half a script
 *
 * `xcrun simctl` can install, launch and photograph, and that is the whole of
 * its interface with a running app: there is no tap, no swipe and no rotate,
 * which is the reason `src/dev/launch-intent.ts` exists at all — a launch
 * argument is the one channel that opens a screen without a finger. Most of the
 * scenes below are one launch and one capture, and those this script does by
 * itself.
 *
 * The rest are behind a tap. Rather than pretend otherwise, this script LAUNCHES
 * the app into the nearest state a launch argument can reach, prints the taps
 * that finish the scene, and waits for the operator to press Return before it
 * captures. So a rerun is a walk through a written list rather than a memory
 * test, and every scene names the fixture it shows.
 *
 * ## Before it runs
 *
 * A fake gateway, a Metro server and a Debug build installed on each simulator.
 * `design/store/screenshots/ios/README.md` has the exact commands, including the
 * two settings that are STORED on the device and therefore survive relaunches —
 * the folders and the pinned chat in the list, and the two prompts that put a
 * diagram and a formula into the transcript.
 *
 * ## What it does to the file
 *
 * `simctl io screenshot` writes an `sRGB` chunk beside the image. That is not
 * metadata, but "what the tool felt like writing" is not a thing to publish
 * unread, so every file is decoded and re-encoded from its pixels with no
 * ancillary chunks at all — IHDR, IDAT, IEND and nothing else, which is also how
 * the absence of EXIF is demonstrated rather than assumed. The same rule made
 * the Play set; see `design/store/README.md`.
 *
 * **Nothing is scaled and nothing is cropped.** A simulator's native capture is
 * its device's exact pixel size, and each device below was picked because that
 * size is one App Store Connect accepts outright. A capture that comes back a
 * different size is a different device, not a file to resize, so this refuses it
 * rather than quietly resampling a store asset.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PNG } from 'pngjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outDir = resolve(repoRoot, 'design/store/screenshots/ios')

/** The gateway and Metro the launches point at; override from the environment. */
const GATEWAY = process.env.HERMIE_SHOT_GATEWAY ?? 'http://127.0.0.1:9119'
const METRO = process.env.HERMIE_SHOT_METRO ?? 'http://localhost:8081'
const TOKEN = process.env.HERMIE_SHOT_TOKEN ?? 'devtoken'
const BUNDLE = 'dev.hermie.app'

/**
 * The two devices, and why these two.
 *
 * App Store Connect asks for one iPhone size and one iPad size, and accepts the
 * others as optional. The required pair since 2024 is the 6.9-inch iPhone and
 * the 13-inch iPad, and each simulator below reports EXACTLY one of the pixel
 * sizes that size accepts — no scaling step stands between the capture and the
 * upload.
 *
 * The 6.5-inch iPhone (1284 x 2778 / 1242 x 2688) is not here. It is no longer
 * required, and producing it would need an iOS 16-era runtime for an iPhone 11
 * Pro Max or XS Max, which this machine does not have installed.
 */
const DEVICES = {
  iphone69: {
    /** iPhone 17 Pro Max: 440 x 956 pt at 3x. */
    udid: process.env.HERMIE_SHOT_IPHONE ?? '66195580-B36A-4AB9-9306-CEB8800F13B2',
    name: 'iPhone 17 Pro Max',
    prefix: 'iphone69',
    size: [1320, 2868],
    storeSize: '6.9-inch iPhone'
  },
  ipad13: {
    /** iPad Pro 13-inch (M5): 1032 x 1376 pt at 2x, portrait. */
    udid: process.env.HERMIE_SHOT_IPAD ?? '86D0AE46-5541-48D2-B9CF-8D7624C998DE',
    name: 'iPad Pro 13-inch (M5)',
    prefix: 'ipad13',
    size: [2064, 2752],
    storeSize: '13-inch iPad'
  }
}

/**
 * The scenes, in the order the listing shows them.
 *
 * `open` is the `--hermieOpen` value, or null for the chat list, which is where
 * a launch with no target lands. `taps` is what a launch argument cannot do; an
 * empty list means the launch IS the scene and the script captures it without
 * asking. `only` narrows a scene to one device — the board is the one scene
 * whose whole point is the wide layout.
 */
const SCENES = [
  {
    slug: 'chats',
    open: null,
    scheme: 'dark',
    taps: [],
    shows:
      'The chat list: a pinned chat above a folder, presence beads and unread dots. On the iPad the chat takes the column beside it.'
  },
  {
    slug: 'conversation',
    open: 'chat:researcher',
    scheme: 'dark',
    taps: [],
    shows: 'One conversation: a Mermaid flowchart and a typeset formula, each with its duration-and-token footer.'
  },
  {
    slug: 'options',
    open: 'chat:researcher',
    scheme: 'dark',
    taps: ['Tap the round (…) at the trailing end of the chat header.'],
    shows:
      'The chat options: the conversation switch, the per-chat modes, model, reasoning and colour. A popover on a wide column, a sheet on a narrow one — the split is a measured 400pt, so a modern phone gets the popover.'
  },
  {
    slug: 'memory',
    open: 'overlay:settings',
    scheme: 'dark',
    taps: ['Scroll to MEMORY and tap Memory.', 'Tap researcher.', 'Tap the Graph tab.'],
    shows: 'The memory graph: what one bot remembers, as entries and the topics they share.'
  },
  {
    slug: 'crons',
    open: 'overlay:cron',
    scheme: 'dark',
    taps: [],
    shows:
      'The crons: Active over Paused, each with its schedule, its delivery target, its profile and its next run — and the one whose last run failed saying so.'
  },
  {
    slug: 'board',
    open: null,
    scheme: 'dark',
    only: 'ipad13',
    taps: ['Tap the (…) in the chat list header.', 'Tap Boards.', 'Tap the Default board.'],
    shows:
      'A Kanban board in the content column, its columns side by side beside the chat list — the layout R20 made reachable.'
  },
  {
    slug: 'appearance',
    open: 'overlay:settings',
    scheme: 'light',
    taps: ['Scroll to APPEARANCE and THEME.'],
    shows:
      'Settings → Appearance: the scheme switch, the bot-name and text-size choices, and the three theme presets, in the light scheme.'
  },
  {
    slug: 'conversations',
    open: 'chat:researcher',
    scheme: 'light',
    taps: ['Tap the round (…).', 'Scroll the popover to WHAT THIS CONVERSATION SHOWS.', 'Tap Conversations.'],
    shows:
      "A bot's other conversations: the shared Bot Chat against your own, the current one, and the ones /new put away."
  }
]

function sh(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Re-encode from the pixels, so the published file carries IHDR, IDAT and IEND
 * and nothing else.
 */
function stripChunks(file) {
  const source = PNG.sync.read(readFileSync(file))
  const out = new PNG({ width: source.width, height: source.height, colorType: 2, inputHasAlpha: true })

  source.data.copy(out.data)
  writeFileSync(file, PNG.sync.write(out, { colorType: 2, inputHasAlpha: true, deflateLevel: 9 }))

  return [source.width, source.height]
}

/**
 * Always through a fresh temporary file, because `simctl io screenshot` REFUSES
 * to write over one that already exists — it fails with `NSCocoaErrorDomain 513`
 * and the words "You don't have permission", which is nothing to do with
 * permissions. Writing in place would therefore work exactly once per file and
 * fail on every rerun, which is the one thing this script exists to make easy.
 */
function capture(udid, file, expected) {
  mkdirSync(dirname(file), { recursive: true })

  const scratch = join(tmpdir(), `hermie-shot-${process.pid}-${Date.now()}.png`)

  sh('xcrun', ['simctl', 'io', udid, 'screenshot', scratch])
  renameSync(scratch, file)

  const [width, height] = stripChunks(file)

  if (expected && (width !== expected[0] || height !== expected[1])) {
    throw new Error(
      `${file} came back ${width}x${height}, and the store size is ${expected[0]}x${expected[1]}. ` +
        'That is a different device, not a file to resize — check the udid rather than scaling a store asset.'
    )
  }

  return [width, height]
}

/**
 * Resample a capture to a smaller size, for the README's own images.
 *
 * Store assets are never resized — see the header — but the README is a web
 * page, and a 2064 px wide image in a table cell is three megabytes nobody
 * reads. `sips` does the resampling and the pixels are then re-encoded the same
 * way a capture is, so a README image carries no more chunks than a store one.
 */
function scaleTo(source, file, expected) {
  mkdirSync(dirname(file), { recursive: true })

  const scratch = join(tmpdir(), `hermie-scale-${process.pid}-${Date.now()}.png`)

  sh('sips', ['--resampleHeightWidth', String(expected[1]), String(expected[0]), source, '--out', scratch])
  renameSync(scratch, file)

  const [width, height] = stripChunks(file)

  if (width !== expected[0] || height !== expected[1]) {
    throw new Error(`${file} came out ${width}x${height}, not ${expected[0]}x${expected[1]}.`)
  }

  return [width, height]
}

function launch(device, scene) {
  try {
    sh('xcrun', ['simctl', 'terminate', device.udid, BUNDLE])
  } catch {
    // Not running is the normal case on the first scene.
  }

  const args = [
    'simctl',
    'launch',
    device.udid,
    BUNDLE,
    '--initialUrl',
    METRO,
    '--hermieGateway',
    GATEWAY,
    '--hermieToken',
    TOKEN,
    '--hermieTheme',
    scene.scheme
  ]

  if (scene.open) {
    args.push('--hermieOpen', scene.open)
  }

  sh('xcrun', args)
}

const wait = ms => new Promise(done => setTimeout(done, ms))

async function main() {
  const argv = process.argv.slice(2)

  if (argv[0] === 'capture') {
    const [, udid, file, size] = argv
    const expected = size ? size.split('x').map(Number) : null
    const [width, height] = capture(udid, resolve(process.cwd(), file), expected)

    console.log(`${file}  ${width}x${height}`)

    return
  }

  if (argv[0] === 'scale') {
    const [, source, file, size] = argv
    const [width, height] = scaleTo(
      resolve(process.cwd(), source),
      resolve(process.cwd(), file),
      size.split('x').map(Number)
    )

    console.log(`${file}  ${width}x${height}`)

    return
  }

  const pick = value => {
    const index = argv.indexOf(value)

    return index === -1 ? null : argv[index + 1]
  }

  const wantedDevice = pick('--device')
  const wantedScheme = pick('--scheme')
  const devices = Object.values(DEVICES).filter(device => !wantedDevice || device.prefix === wantedDevice)
  const rows = []

  if (argv.includes('--list')) {
    for (const device of devices) {
      SCENES.filter(scene => !scene.only || scene.only === device.prefix).forEach((scene, index) => {
        console.log(`${device.prefix}-${String(index + 1).padStart(2, '0')}-${scene.slug}-${scene.scheme}.png`)
      })
    }

    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  for (const device of devices) {
    const scenes = SCENES.filter(scene => !scene.only || scene.only === device.prefix).filter(
      scene => !wantedScheme || scene.scheme === wantedScheme
    )

    for (const [index, scene] of scenes.entries()) {
      const n = String(index + 1).padStart(2, '0')
      const file = resolve(outDir, `${device.prefix}-${n}-${scene.slug}-${scene.scheme}.png`)

      console.log(`\n${device.name} — ${scene.slug} (${scene.scheme})`)
      console.log(`  ${scene.shows}`)

      launch(device, scene)
      await wait(9000)

      if (scene.taps.length > 0) {
        scene.taps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`))
        await rl.question('  Press Return when the screen is right. ')
      }

      const [width, height] = capture(device.udid, file, device.size)

      rows.push({ device, scene, file, width, height })
      console.log(`  wrote ${file.replace(`${repoRoot}/`, '')}  ${width}x${height}`)
    }
  }

  rl.close()

  if (rows.length > 0 && !existsSync(resolve(outDir, 'README.md'))) {
    console.log('\nNo README.md beside the images — write one; the set is unreadable without it.')
  }
}

await main()
