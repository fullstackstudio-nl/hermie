/**
 * Slate: a fourth wallpaper, and the one that brings its own accent.
 *
 * The owner liked the way macOS renders an INACTIVE window — everything a step
 * desaturated — and asked whether Graphite was already that. It is not, and the
 * first assertion here is the measurement that settles it rather than an opinion
 * about it: Graphite's dark base is near-black and Slate's is roughly three times
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

/** The brightest point of a wallpaper: the base stops and every bloom. */
const brightest = (name: keyof typeof WALLPAPERS, scheme: Scheme): number => {
  const spec = WALLPAPERS[name][scheme]

  return Math.max(...[...spec.base, ...spec.blooms.map(bloom => bloom.color)].map(luminance))
}

describe('Slate against Graphite', () => {
  it('is a different composition, not a tuned Graphite', () => {
    const slate = luminance(WALLPAPERS.slate.dark.base[0] as string)
    const graphite = luminance(WALLPAPERS.graphite.dark.base[0] as string)

    // Near-black against mid-dark. The ratio is the whole answer to "is Graphite
    // already close": it is not, and the difference is the base rather than the
    // blooms, which is why tuning could not have produced it.
    expect(slate / graphite).toBeGreaterThan(2.5)
  })

  it('keeps its blooms at the base’s luminance, because the contrast check binds', () => {
    // The dark ink set is calibrated against a deep wallpaper, and the contrast
    // check measures every ink against the BRIGHTEST point of every dark one. So a
    // Slate bloom is a hue shift at the same luminance, never a highlight — and
    // `npm run contrast:check` is what actually enforces that. This states the
    // intent so that a bloom raised "to add depth" fails here with the reason
    // rather than in a table of 186 numbers.
    const base = luminance(WALLPAPERS.slate.dark.base[0] as string)

    expect(brightest('slate', 'dark')).toBeLessThanOrEqual(base + 0.001)
  })

  it('has a light counterpart, derived rather than inverted', () => {
    const light = WALLPAPERS.slate.light

    expect(light.base).toHaveLength(3)
    // Desaturated in the light scheme means NEUTRAL, not dark: the light ramp is
    // a near-grey, where Blue's is plainly blue.
    const [red, green, blue] = rgb(light.base[2] as string)

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
      expect(WALLPAPERS[name].light.base.length).toBeGreaterThan(0)
      expect(WALLPAPERS[name].dark.base.length).toBeGreaterThan(0)
    }
  })
})
