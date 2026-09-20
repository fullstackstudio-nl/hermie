/**
 * Contrast on the COMPOSITED surface, as a check rather than as a paragraph.
 *
 * A glass surface is never the colour of a token: it is an alpha gradient over a
 * rung of the elevation ladder, or over a blurred wallpaper, and the ink sits on
 * whatever that composites to. So measuring a token against a token proves
 * nothing, and the previous rounds' numbers lived in a scratchpad script and a
 * table in docs/platform-notes.md that nothing kept honest.
 *
 * Everything here is READ FROM `apps/hermie/src/ui/tokens.ts`. That is the whole
 * point: a copy of the palette in a checker is a second palette, and the first
 * thing a second palette does is disagree.
 *
 *   npm run contrast            # the table
 *   npm run contrast:check      # fails under the thresholds below
 *
 * The thresholds are WCAG AA: 4.5 : 1 for anything that has to be read as text,
 * 3 : 1 for a mark that only has to be seen — a status dot, a hairline that
 * carries meaning. Which ink is which is `TEXT_ROLES` below, and a role that is
 * used as ink has to be in it.
 */
import {
  ACCENT_ORDER,
  ACCENTS,
  DANGER_SOFT,
  darkBubbles,
  darkColors,
  darkGlass,
  lightBubbles,
  lightColors,
  lightGlass,
  OK_SOFT,
  TINT_SUNK,
  WALLPAPERS,
  type BubbleVariant,
  type ColorRole,
  type ColorScale,
  type GlassVariant,
  type Scheme
} from '../apps/hermie/src/ui/tokens'

type Rgb = [number, number, number]

const AA_TEXT = 4.5
const AA_MARK = 3

/**
 * Inks that carry words. `ok` is NOT here: it is the status DOT's fill, and the
 * readable variant beside it is `okText` — the same split `danger` has had all
 * along, and the one §1.1 was missing.
 */
const TEXT_ROLES: readonly ColorRole[] = [
  'text',
  'textMuted',
  'textFaint',
  'accentText',
  'dangerText',
  'okText',
  'warnText'
]

/**
 * Inks that only have to be SEEN: today that is the cron status dot's fill.
 *
 * `accent` and `danger` are deliberately absent. They are FILLS — a button, a
 * badge — and what has to be readable on one is `onAccent`, which is checked
 * against the accent gradient at the bottom of this file. Measuring a fill
 * against the surface it sits on answers a question nobody asked; where either
 * is used as INK the readable variant to reach for is `accentText` / `dangerText`.
 */
const MARK_ROLES: readonly ColorRole[] = ['ok']

function parse(color: string): { rgb: Rgb; alpha: number } {
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(color)

  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4])
    }
  }

  const hex = color.replace('#', '')
  const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex

  return { rgb: [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16)) as Rgb, alpha: 1 }
}

function over(top: string, bottom: Rgb): Rgb {
  const { rgb, alpha } = parse(top)

  return rgb.map((channel, at) => channel * alpha + bottom[at] * (1 - alpha)) as Rgb
}

function channelLuminance(channel: number): number {
  const scaled = channel / 255

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue)
}

function contrast(ink: string, background: Rgb): number {
  const [lighter, darker] = [luminance(parse(ink).rgb), luminance(background)].sort((a, b) => b - a) as [number, number]

  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

/**
 * Each wallpaper, as the one colour it now is.
 *
 * This used to hunt for the worst POINT of a wallpaper — the brightest bloom in
 * dark, the darkest in light — because a wallpaper was a ramp plus coloured
 * corner washes and a bubble could land on any of them. There is nothing to hunt
 * any more: a wallpaper is one flat fill, so the number that has to clear AA is
 * simply that fill. Every ratio in the table can only have improved, because the
 * colour kept is the end of the old ramp furthest from the ink.
 */
function wallpaperExtremes(scheme: Scheme): { name: string; rgb: Rgb }[] {
  return Object.entries(WALLPAPERS).map(([name, bySchema]) => ({ name, rgb: parse(bySchema[scheme].fill).rgb }))
}

interface Surface {
  name: string
  /** The composited background this surface's ink actually sits on. */
  background: (wallpaper: Rgb) => Rgb
}

function surfaces(scheme: Scheme): Surface[] {
  const glass = scheme === 'dark' ? darkGlass : lightGlass
  const bubbles = scheme === 'dark' ? darkBubbles : lightBubbles
  const out: Surface[] = []

  for (const variant of ['panel', 'sheet', 'card', 'control'] as GlassVariant[]) {
    const recipe = glass[variant]

    out.push({
      name: variant,
      // Blurred: the wash over the wallpaper itself. That is the real case
      // on iOS and the harsher of the two; the opaque fallback is strictly
      // easier to read on, so it cannot be what fails.
      background: wallpaper => over(recipe.fill, wallpaper)
    })
  }

  for (const variant of ['in', 'inRead', 'dm', 'dmRead'] as BubbleVariant[]) {
    const recipe = bubbles[variant]

    out.push({
      // A bubble is NOT glass (§7.4): it paints its own opaque rung and
      // composites the recipe onto that, so the wallpaper never reaches the ink.
      name: `bubble ${variant}`,
      background: () => over(recipe.fill, parse(recipe.solid).rgb)
    })
  }

  out.push({
    name: 'sunk tint',
    background: wallpaper => over(TINT_SUNK[scheme], over(glass.panel.fill, wallpaper))
  })

  /**
   * The two soft fills, on the surface they are actually used on.
   *
   * A `Deny` button, a scheduler-down banner, a locked-answer chip: each is a
   * low-alpha wash over a SHEET, with `dangerText` / `okText` on it. That is a
   * composite nothing else in this table covers — the ink is measured against
   * the sheet, and the wash shifts the sheet toward the ink's own hue, which is
   * the direction that costs contrast.
   */
  out.push({
    name: 'danger tint',
    background: wallpaper => over(DANGER_SOFT[scheme], over(glass.sheet.fill, wallpaper))
  })

  out.push({
    name: 'ok tint',
    background: wallpaper => over(OK_SOFT[scheme], over(glass.sheet.fill, wallpaper))
  })

  return out
}

interface Row {
  scheme: Scheme
  surface: string
  role: ColorRole
  ratio: number
  wallpaper: string
  floor: number
}

function measure(): Row[] {
  const rows: Row[] = []

  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const colors: ColorScale = scheme === 'dark' ? darkColors : lightColors

    for (const surface of surfaces(scheme)) {
      for (const role of [...TEXT_ROLES, ...MARK_ROLES]) {
        const floor = (TEXT_ROLES as readonly string[]).includes(role) ? AA_TEXT : AA_MARK
        let worst: Row | null = null

        for (const wallpaper of wallpaperExtremes(scheme)) {
          const ratio = contrast(colors[role], surface.background(wallpaper.rgb))

          if (!worst || ratio < worst.ratio) {
            worst = { scheme, surface: surface.name, role, ratio, wallpaper: wallpaper.name, floor }
          }
        }

        if (worst) {
          rows.push(worst)
        }
      }
    }
  }

  return rows
}

/**
 * White on the outgoing bubble.
 *
 * The one place a fill's own readability is the question: the outgoing bubble is
 * the chat's accent and the body on it is `onAccent`. It used to be a gradient,
 * and the stop measured here was its lighter — the harder — one; that stop is now
 * the whole bubble, so this row is the same number about a simpler thing. Every
 * accent has to clear AA or a chat's colour becomes a choice between a look and a
 * legible message.
 */
function accentRows(): Row[] {
  return ACCENT_ORDER.map(name => ({
    scheme: 'light' as Scheme,
    surface: `accent ${name}`,
    role: 'onAccent' as ColorRole,
    ratio: contrast(lightColors.onAccent, parse(ACCENTS[name].bubble).rgb),
    wallpaper: '—',
    floor: AA_TEXT
  }))
}

function main(): void {
  const check = process.argv.includes('--check')
  const rows = [...measure(), ...accentRows()]
  const failures = rows.filter(row => row.ratio < row.floor)

  if (!check) {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      process.stdout.write(`\n## ${scheme}\n`)

      for (const row of rows.filter(entry => entry.scheme === scheme && !entry.surface.startsWith('accent '))) {
        const mark = row.ratio < row.floor ? `   <-- below ${row.floor}` : ''

        process.stdout.write(
          `${`${row.surface}/${row.role}`.padEnd(28)}${String(row.ratio).padStart(7)} : 1   (worst: ${row.wallpaper})${mark}\n`
        )
      }
    }
  }

  if (!check) {
    process.stdout.write('\n## white on the outgoing bubble\n')

    for (const row of rows.filter(entry => entry.surface.startsWith('accent '))) {
      const mark = row.ratio < row.floor ? `   <-- below ${row.floor}` : ''

      process.stdout.write(`${row.surface.padEnd(28)}${String(row.ratio).padStart(7)} : 1${mark}\n`)
    }
  }

  if (!failures.length) {
    process.stdout.write(`\n${rows.length} pairs checked, all at or above their floor.\n`)

    return
  }

  process.stderr.write(`\n${failures.length} pair(s) below the floor:\n`)

  for (const row of failures) {
    process.stderr.write(
      `  ${row.scheme} ${row.surface} / ${row.role}: ${row.ratio} : 1 (needs ${row.floor}, worst wallpaper: ${row.wallpaper})\n`
    )
  }

  if (check) {
    process.exitCode = 1
  }
}

main()
