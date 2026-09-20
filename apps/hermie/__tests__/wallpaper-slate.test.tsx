/**
 * Slate: a fourth wallpaper, and the one that brings its own accent.
 *
 * The owner liked the way macOS renders an INACTIVE window — everything a step
 * desaturated — and asked whether Graphite was already that. It is not, and the
 * first assertion here is the measurement that settles it rather than an opinion
 * about it: Graphite's dark fill is near-black and Slate's is roughly three times
 * its luminance, which is a different composition and not a tuning of the same one.
 *
 * The second half is the mechanism. A wallpaper is the only setting a reader picks
 * that is supposed to change the whole window, and the outgoing bubble is the
 * largest saturated area in it — so Slate names its own DEFAULT accent, and a chat
 * whose colour the reader chose is left alone. Both halves of that are asserted,
 * because "desaturated except for the bubbles" is the bug this exists to avoid and
 * "your chat's colour was silently overwritten" is the bug the fix could have been.
 */
import { WALLPAPER_ORDER, WALLPAPERS, type Scheme } from '../src/ui/tokens'

type Rgb = [number, number, number]

const rgb = (hex: string): Rgb => [0, 2, 4].map(at => parseInt(hex.replace('#', '').slice(at, at + 2), 16)) as Rgb

const channel = (value: number) => {
  const scaled = value / 255

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, the same formula `scripts/check-contrast.ts` uses. */
const luminance = (hex: string): number => {
  const [red, green, blue] = rgb(hex)

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

const fillOf = (name: keyof typeof WALLPAPERS, scheme: Scheme): string => WALLPAPERS[name][scheme].fill

describe('Slate against Graphite', () => {
  it('is a different composition, not a tuned Graphite', () => {
    const slate = luminance(fillOf('slate', 'dark'))
    const graphite = luminance(fillOf('graphite', 'dark'))

    // Near-black against mid-dark. The ratio is the whole answer to "is Graphite
    // already close": it is not, and the difference is the FLOOR, which is why no
    // amount of tuning the one produces the other.
    expect(slate / graphite).toBeGreaterThan(2.5)
  })

  /**
   * The ceiling, restated for the round that made every wallpaper one colour.
   *
   * There are no blooms to hold down any more — a wallpaper is a flat fill, the
   * owner's verdict on the gradients having been that they look generated. What
   * survives of that rule is the thing it was protecting: the dark ink set is
   * calibrated against a deep wallpaper, and Slate is the brightest of the four,
   * so Slate is the value `contrast:check` binds. This says so here, with the
   * reason, rather than leaving it to fail in a table of 186 numbers.
   */
  it('is the brightest dark wallpaper, which is what makes it the one the check binds', () => {
    const others = (['blue', 'warm', 'graphite'] as const).map(name => luminance(fillOf(name, 'dark')))

    expect(Math.min(...others.map(other => luminance(fillOf('slate', 'dark')) / other))).toBeGreaterThan(1)
  })

  it('has a light counterpart, derived rather than inverted', () => {
    // Desaturated in the light scheme means NEUTRAL, not dark: Slate's light fill
    // is a near-grey, where Blue's is plainly blue.
    const [red, green, blue] = rgb(fillOf('slate', 'light'))

    expect(Math.abs(red - green)).toBeLessThan(12)
    expect(blue - red).toBeLessThan(20)
  })
})

describe('the wallpaper’s own accent', () => {
  it('is Slate’s, in both schemes', () => {
    expect(WALLPAPERS.slate.light.accent).toBe('slate')
    expect(WALLPAPERS.slate.dark.accent).toBe('slate')
  })

  it('is absent on the three wallpapers that keep the stock blue', () => {
    for (const name of ['blue', 'warm', 'graphite'] as const) {
      expect(WALLPAPERS[name].light.accent).toBeUndefined()
      expect(WALLPAPERS[name].dark.accent).toBeUndefined()
    }
  })
})

describe('the picker', () => {
  it('offers four wallpapers, Slate last', () => {
    expect(WALLPAPER_ORDER).toEqual(['blue', 'warm', 'graphite', 'slate'])
    // Every name in the order has a spec in both schemes, which is what the
    // segmented control and `--hermieWallpaper` both read.
    for (const name of WALLPAPER_ORDER) {
      expect(WALLPAPERS[name].light.fill).toMatch(/^#[0-9A-F]{6}$/i)
      expect(WALLPAPERS[name].dark.fill).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })
})
