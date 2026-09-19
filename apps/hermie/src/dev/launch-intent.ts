/**
 * Open the app straight onto one surface, from the command line.
 *
 * **Why this exists.** This machine has no `Simulator.app`, so `xcrun simctl` is
 * the whole toolbox: an app can be launched and photographed and nothing else —
 * no taps, no swipes, no rotation (docs/platform-notes.md, "The wide layout, on
 * an iPad simulator"). Three consecutive design rounds therefore shipped every
 * sheet, every options page and the colour picker without anyone having seen one
 * of them, because all of it sits behind a tap. Launch arguments are the one
 * channel `simctl` does have, and one launch then equals one screenshot:
 *
 * ```sh
 * xcrun simctl launch <udid> nl.fullstackstudio.hermie \
 *   --initialUrl http://localhost:8081 \
 *   --hermieOpen gallery:sheets/options-model-page --hermieTheme dark
 * ```
 *
 * **Why it cannot reach a release build.** Three independent gates, because a
 * back door that opens arbitrary screens is not something to leave one flag away
 * from a shipped app:
 *
 *  1. the constant it reads is inside `#if DEBUG` in `HermieMacModule.swift`, so
 *     a Release binary does not define it at all;
 *  2. `__DEV__` is checked here, and Metro's minifier folds `if (false)` and the
 *     code inside it out of a production bundle;
 *  3. nothing is registered with the system — no URL scheme, no
 *     `CFBundleURLTypes`, no entitlement, no associated domain. Launch arguments
 *     are visible only to the process itself, and nothing but a debugger or
 *     `simctl` can set them on a device.
 *
 * `__tests__/dev-launch-intent.test.ts` asserts the `__DEV__` gate.
 *
 * **The grammar**, deliberately tiny and order-independent:
 *
 * | Argument                      | Meaning                                          |
 * | ----------------------------- | ------------------------------------------------ |
 * | `--hermieOpen gallery:<id>`   | one gallery section, alone, filling the screen   |
 * | `--hermieOpen sheet:<name>`   | shorthand for that sheet's gallery section       |
 * | `--hermieOpen chat:<handle>`  | the real chat screen for that bot                |
 * | `--hermieOpen overlay:<s>[/p]`| Activity / Crons / Settings, and a settings page |
 * | `--hermieTheme light\|dark`   | pin the scheme, whatever the simulator is set to |
 * | `--hermieWallpaper <name>`    | pin the wallpaper                                |
 *
 * `--hermieOpen=<value>` is accepted as well, because a shell quoting habit
 * should not be the reason a screenshot comes back wrong.
 */
import { requireOptionalNativeModule } from 'expo'

import { WALLPAPER_ORDER, type Scheme, type WallpaperName } from '../ui/tokens'

/** The three destinations that are not the gallery. */
export type DevOverlaySection = 'activity' | 'cron' | 'settings'

/** A page Settings opens over itself; the wide layout has no navigator for it. */
export type DevSettingsPage = 'connection' | 'gallery' | 'licences'

export type DevOpenTarget =
  | { kind: 'gallery'; section: string }
  | { kind: 'chat'; bot: string }
  | { kind: 'overlay'; section: DevOverlaySection; page?: DevSettingsPage }

export interface DevLaunchIntent {
  open?: DevOpenTarget
  scheme?: Scheme
  wallpaper?: WallpaperName
}

const OVERLAY_SECTIONS: Record<string, DevOverlaySection> = {
  activity: 'activity',
  cron: 'cron',
  crons: 'cron',
  routines: 'cron',
  settings: 'settings'
}

const SETTINGS_PAGES: Record<string, DevSettingsPage> = {
  connection: 'connection',
  'connection-test': 'connection',
  gallery: 'gallery',
  licences: 'licences',
  licenses: 'licences'
}

/** `sheet:approval` → the gallery section that holds the approval sheet. */
const SHEET_SECTIONS: Record<string, string> = {
  agents: 'sheet-agents',
  approval: 'sheet-approval',
  'approval-answered': 'sheet-approval-answered',
  clarify: 'sheet-clarify',
  'clarify-batch': 'sheet-clarify-batch',
  colour: 'sheet-options-colour-page',
  color: 'sheet-options-colour-page',
  cron: 'sheet-cron-editor',
  'cron-editor': 'sheet-cron-editor',
  model: 'sheet-options-model-page',
  options: 'sheet-options',
  reasoning: 'sheet-options-reasoning-page'
}

function parseTarget(value: string): DevOpenTarget | undefined {
  const at = value.indexOf(':')
  const kind = (at < 0 ? value : value.slice(0, at)).trim().toLowerCase()
  const rest = at < 0 ? '' : value.slice(at + 1).trim()

  if (kind === 'gallery') {
    return rest ? { kind: 'gallery', section: rest } : { kind: 'gallery', section: '' }
  }

  if (kind === 'sheet') {
    const section = SHEET_SECTIONS[rest.toLowerCase()]

    return section ? { kind: 'gallery', section } : undefined
  }

  if (kind === 'chat') {
    return rest ? { kind: 'chat', bot: rest } : undefined
  }

  if (kind === 'overlay') {
    const [head = '', tail = ''] = rest.split('/')
    const section = OVERLAY_SECTIONS[head.toLowerCase()]

    if (!section) {
      return undefined
    }

    const page = section === 'settings' ? SETTINGS_PAGES[tail.toLowerCase()] : undefined

    return { kind: 'overlay', section, ...(page ? { page } : {}) }
  }

  return undefined
}

/**
 * Read one intent out of an argv array. Pure, so it is the part with tests.
 *
 * Returns `null` when nothing in the array asks for anything, which is the
 * ordinary case: every simulator launch carries arguments, and almost none of
 * them are ours.
 */
export function parseDevLaunchArguments(argv: readonly string[]): DevLaunchIntent | null {
  const intent: DevLaunchIntent = {}

  const valueAt = (index: number, inline: string | undefined): string => {
    if (inline !== undefined) {
      return inline
    }

    const next = argv[index + 1]

    // A following token that is itself a flag is somebody else's argument, not
    // our value — `--hermieOpen --hermieTheme dark` asks for nothing.
    return next && !next.startsWith('--') ? next : ''
  }

  argv.forEach((raw, index) => {
    const eq = raw.indexOf('=')
    const flag = (eq < 0 ? raw : raw.slice(0, eq)).toLowerCase()
    const inline = eq < 0 ? undefined : raw.slice(eq + 1)

    if (flag === '--hermieopen') {
      const target = parseTarget(valueAt(index, inline))

      if (target) {
        intent.open = target
      }

      return
    }

    if (flag === '--hermietheme') {
      const value = valueAt(index, inline).toLowerCase()

      if (value === 'light' || value === 'dark') {
        intent.scheme = value
      }

      return
    }

    if (flag === '--hermiewallpaper') {
      const value = valueAt(index, inline).toLowerCase()

      if ((WALLPAPER_ORDER as readonly string[]).includes(value)) {
        intent.wallpaper = value as WallpaperName
      }
    }
  })

  return intent.open || intent.scheme || intent.wallpaper ? intent : null
}

type DevLaunchModule = { devLaunchArguments?: unknown }

function nativeArguments(): readonly string[] {
  try {
    const value = requireOptionalNativeModule<DevLaunchModule>('HermieMac')?.devLaunchArguments

    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    // No Expo module host: a unit test renderer, or Android, where the module is
    // Apple-only. Nothing to read is the honest answer, not an error.
    return []
  }
}

/**
 * The intent this process was launched with, or `null`.
 *
 * Evaluated once, at module load, because launch arguments cannot change while
 * the process lives — and because a value read once is a value a production
 * bundle can drop entirely.
 */
export const DEV_LAUNCH_INTENT: DevLaunchIntent | null = __DEV__ ? parseDevLaunchArguments(nativeArguments()) : null
