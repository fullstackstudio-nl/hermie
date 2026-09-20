// Design tokens. Everything visual resolves through here so that the compact
// and regular shells cannot drift apart, and so a future theme is a data change.
//
// The values are the Liquid Glass direction from `design/liquid-glass-tokens.md`
// and `design/liquid-glass.html`: floating glass panels over a coloured
// wallpaper, a dark elevation ladder whose rungs are measurably apart, and blue
// bubble shades deliberately deeper than the platform default so white body text
// keeps AA contrast.
//
// Two things in here are not decoration and should not be "tidied":
//
//  - The dark rungs (`elevation`) are what the solid fallback falls back TO. A
//    platform with no blur composites the same hierarchy out of flat colours, so
//    a card on a panel on a wallpaper is still three distinguishable tones.
//  - `danger` is the FILL and `dangerText` is the readable one. They are not
//    interchangeable and a `Text` always wants the second: the fill is chosen to
//    carry white, so as ink on glass it fails AA in light mode. The Part-1
//    aliases that blurred the two (and eight other Messenger-era colour names,
//    and five older type names) are gone — see the CHANGELOG for the mapping.

export type Scheme = 'light' | 'dark'

/**
 * The colour roles a `Text` can ask for by name.
 *
 * Exactly §1.1 of the token document, and nothing else. A surface colour is not
 * in here on purpose: it comes off the elevation ladder or a glass recipe, which
 * is what keeps a component from inventing a rung.
 */
export type ColorRole =
  | 'text'
  | 'textMuted'
  | 'textFaint'
  | 'onAccent'
  | 'accent'
  | 'accentText'
  | 'danger'
  | 'dangerText'
  | 'ok'
  | 'okText'
  | 'warnText'

export type ColorScale = Record<ColorRole, string>

export const lightColors: ColorScale = {
  text: '#12151C',
  textMuted: '#4B5462',
  textFaint: '#586171',
  onAccent: '#FFFFFF',
  accent: '#1668E3',
  accentText: '#0B57C4',
  danger: '#C0293A',
  dangerText: '#A81F30',
  ok: '#1C8547',
  okText: '#116038',
  warnText: '#865600'
}

export const darkColors: ColorScale = {
  text: '#F3F6FB',
  textMuted: '#C8D2E0',
  textFaint: '#CBD5E4',
  onAccent: '#FFFFFF',
  accent: '#2C7BEA',
  accentText: '#B4D6FF',
  danger: '#D8465A',
  dangerText: '#FFC2CD',
  ok: '#5CCB86',
  okText: '#8FE3B0',
  warnText: '#FFCB61'
}

/**
 * The dark elevation ladder, and the light rungs that share its names.
 *
 * The first dark pass read as one flat black field. Every surface now sits on a
 * named rung of one blue-slate ramp, each a measurable step lighter than the one
 * below it. The names are shared with light so a component never branches on the
 * theme to pick a surface.
 */
export type ElevationRung = 'e0' | 'e1' | 'e2' | 'e2s' | 'e3' | 'e3c' | 'e3f' | 'e4'

export type ElevationScale = Record<ElevationRung, string>

export const lightElevation: ElevationScale = {
  e0: '#DCE8FB',
  e1: '#F4F8FE',
  e2: '#EAF1FC',
  e2s: '#E2EDFD',
  e3: '#FFFFFF',
  e3c: '#F7FAFE',
  e3f: '#FDFEFF',
  e4: '#FFFFFF'
}

export const darkElevation: ElevationScale = {
  e0: '#0A1830',
  e1: '#1C2A45',
  e2: '#28385A',
  e2s: '#334670',
  e3: '#3E5480',
  e3c: '#2F4066',
  e3f: '#425A88',
  e4: '#50699A'
}

/** 4pt scale. `space.md` is the default gap between unrelated blocks. */
export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /** The mockup's `--s5`: panel padding, one step above `lg`. */
  panel: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48
} as const

/**
 * The gap between a floating panel and the window edge, and between the two
 * panels. Deliberately off the 4pt scale — it is a window metric, not spacing
 * inside a surface.
 */
export const WINDOW_GAP = 14

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  /** Inset controls: a field, a segment, a tab slot. */
  inset: 12,
  lg: 12,
  thumb: 14,
  xl: 16,
  card: 18,
  bubble: 22,
  sheet: 28,
  panel: 30,
  pill: 999,
  /** The sender-side corner a bubble tucks in so its tail can meet it. */
  tail: 6
} as const

export type TypeStyle = {
  fontSize: number
  lineHeight: number
  fontWeight: '400' | '500' | '600' | '700'
  letterSpacing?: number
}

/**
 * One scale, shared by phone and the wide layout.
 *
 * Body text is NOT scaled up on the wide layout — the same 17pt reads correctly
 * at both sizes and it is the same React Native code. Only the sidebar title has
 * a wide variant.
 *
 * Exactly §3 of the token document. The Part-1 aliases (`display`, `heading`,
 * `callout`, `caption`, `mono`) are gone: two names for one size is two names to
 * keep in step with the mockup, and `caption` in particular was being asked for
 * where `meta` and `micro` mean different things.
 */
export const type = {
  title: { fontSize: 28, lineHeight: 32, fontWeight: '700', letterSpacing: -0.62 },
  titleWide: { fontSize: 30, lineHeight: 34, fontWeight: '700', letterSpacing: -0.66 },
  sheetTitle: { fontSize: 21, lineHeight: 26, fontWeight: '700', letterSpacing: -0.34 },
  chatName: { fontSize: 18, lineHeight: 22, fontWeight: '600', letterSpacing: -0.25 },
  name: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.17 },
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' },
  bodyRead: { fontSize: 17, lineHeight: 27, fontWeight: '400' },
  preview: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  meta: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600', letterSpacing: 0.6 },
  code: { fontSize: 13.5, lineHeight: 21, fontWeight: '400' }
} as const satisfies Record<string, TypeStyle>

export type TypeToken = keyof typeof type

/**
 * Presence: one bead, four states.
 *
 * Colour never carries the meaning alone — the SHAPE differs per state (filled,
 * filled with a still inner dot, filled with a notch, hollow ring) and the chat
 * header repeats the state in words.
 */
export type PresenceState = 'online' | 'working' | 'needsInput' | 'offline'

export type PresenceScale = Record<PresenceState, string>

export const lightPresence: PresenceScale = {
  online: '#20A24B',
  working: '#1668E3',
  needsInput: '#E09000',
  offline: '#8A93A3'
}

export const darkPresence: PresenceScale = {
  online: '#3ED374',
  working: '#5AA4FF',
  needsInput: '#FFB531',
  offline: '#7E8798'
}

/** Bead diameters. 14 on a 48pt avatar, 9 inline in a header or the gateway card. */
export const BEAD_SIZE = { avatar: 14, inline: 9, legend: 18 } as const

/**
 * Per-chat colour: eight curated swatches and Default.
 *
 * It tints exactly four things — the avatar ring, the selected row's glass, the
 * header accent and in-chat links, and the outgoing bubble gradient. The last
 * two are Part 2's; the gradient stops live here so Part 2 needs no second
 * table.
 *
 * `text` is a separate value per scheme because the fill is too dark to read on
 * glass in dark mode and too light in light mode. The dark variants are lighter
 * than they look like they need to be: they have to clear 4.5:1 on a reading
 * bubble, the lightest surface they ever sit on.
 */
export type AccentName = 'default' | 'indigo' | 'violet' | 'magenta' | 'red' | 'orange' | 'teal' | 'green' | 'graphite'

export type AccentSwatch = {
  /** Solid fill: the avatar ring, the swatch itself. */
  fill: string
  /** Readable on glass. Scheme-dependent. */
  text: { light: string; dark: string }
  /** Outgoing bubble gradient, top → bottom. Part 2 draws it. */
  bubble: { top: string; bottom: string }
}

export const ACCENTS: Record<AccentName, AccentSwatch> = {
  default: {
    fill: '#1668E3',
    text: { light: '#0B57C4', dark: '#B4D6FF' },
    bubble: { top: '#2A72DC', bottom: '#0F4FBE' }
  },
  indigo: {
    fill: '#4B4CC8',
    text: { light: '#3F3FB4', dark: '#CCCDFF' },
    bubble: { top: '#5556CE', bottom: '#33309F' }
  },
  violet: {
    fill: '#7B3FC4',
    text: { light: '#6A2FB4', dark: '#E0C8FF' },
    bubble: { top: '#8244CE', bottom: '#5B23A0' }
  },
  magenta: {
    fill: '#B62F81',
    text: { light: '#A22270', dark: '#FFC2E2' },
    bubble: { top: '#C0368A', bottom: '#8E1B64' }
  },
  red: {
    fill: '#C5303A',
    text: { light: '#AE2029', dark: '#FFC2C7' },
    bubble: { top: '#CF3B44', bottom: '#9C1A24' }
  },
  orange: {
    fill: '#B04C08',
    text: { light: '#9A4106', dark: '#FFD0A8' },
    bubble: { top: '#B8540C', bottom: '#8B3A05' }
  },
  teal: {
    fill: '#0E7A84',
    text: { light: '#0A6670', dark: '#A6E8EE' },
    bubble: { top: '#14828C', bottom: '#07606A' }
  },
  green: {
    fill: '#16783C',
    text: { light: '#12652F', dark: '#A8ECBE' },
    bubble: { top: '#1A8043', bottom: '#0E5C2E' }
  },
  graphite: {
    fill: '#485468',
    text: { light: '#3D4859', dark: '#D2DAE6' },
    bubble: { top: '#54607A', bottom: '#343E52' }
  }
}

/** Picker order: Default first, then the eight curated colours. */
export const ACCENT_ORDER: readonly AccentName[] = [
  'default',
  'indigo',
  'violet',
  'magenta',
  'red',
  'orange',
  'teal',
  'green',
  'graphite'
]

/** The soft tint a chat's colour lays under a selected row or an icon well. */
export function accentSoft(name: AccentName, scheme: Scheme): string {
  return withAlpha(ACCENTS[name].fill, scheme === 'dark' ? 0.26 : 0.13)
}

/**
 * Wallpapers: three, each with a light and a dark variant, all gradients.
 *
 * No image files — an app that ships wallpaper PNGs ships them at every scale
 * factor for every device. Dark wallpapers are deep but COLOURED; `#000000` is
 * not a wallpaper.
 *
 * `base` is the diagonal ramp the whole window sits on. `blooms` are the soft
 * corner fields the mockup builds from radial gradients; React Native has no
 * radial gradient, so each one is drawn as a large circle of its colour fading
 * out along the diagonal (see `src/ui/glass/Wallpaper.tsx`).
 */
export type WallpaperName = 'blue' | 'warm' | 'graphite'

export type Bloom = {
  color: string
  /** Centre, as a fraction of the window. */
  x: number
  y: number
  /** Diameter, as a fraction of the window's larger side. */
  size: number
  opacity: number
}

export type WallpaperSpec = {
  base: readonly string[]
  blooms: readonly Bloom[]
}

export const WALLPAPERS: Record<WallpaperName, Record<Scheme, WallpaperSpec>> = {
  blue: {
    light: {
      base: ['#EAF3FF', '#D6E6FF', '#C5DAFB'],
      blooms: [
        { color: '#FFFFFF', x: 0.06, y: 0.02, size: 1.3, opacity: 0.95 },
        { color: '#B9D7FF', x: 0.8, y: 0.08, size: 1.2, opacity: 1 },
        { color: '#C9DDFF', x: 0.96, y: 0.84, size: 1.1, opacity: 1 },
        { color: '#DCEBFF', x: 0.18, y: 0.82, size: 1.0, opacity: 1 },
        { color: '#DBD9FF', x: 0.44, y: 0.96, size: 0.9, opacity: 1 }
      ]
    },
    dark: {
      base: ['#0C1B33', '#0A1628', '#070F1D'],
      blooms: [
        { color: '#17457F', x: 0.78, y: 0.06, size: 1.2, opacity: 1 },
        { color: '#10305C', x: 0.96, y: 0.86, size: 1.1, opacity: 1 },
        { color: '#143A6B', x: 0.12, y: 0.84, size: 1.0, opacity: 1 },
        { color: '#2A2358', x: 0.44, y: 0.98, size: 0.85, opacity: 1 }
      ]
    }
  },
  warm: {
    light: {
      base: ['#FFF3E6', '#FFE4CE', '#F8D6BC'],
      blooms: [
        { color: '#FFFFFF', x: 0.06, y: 0.02, size: 1.3, opacity: 0.92 },
        { color: '#FFD9BC', x: 0.82, y: 0.06, size: 1.2, opacity: 1 },
        { color: '#FFD3D2', x: 0.96, y: 0.86, size: 1.1, opacity: 1 },
        { color: '#FFE9C9', x: 0.16, y: 0.84, size: 1.0, opacity: 1 },
        { color: '#F6DCC0', x: 0.48, y: 0.98, size: 0.86, opacity: 1 }
      ]
    },
    dark: {
      base: ['#2A1708', '#201206', '#160C05'],
      blooms: [
        { color: '#6A3512', x: 0.8, y: 0.06, size: 1.2, opacity: 1 },
        { color: '#5A1F24', x: 0.96, y: 0.86, size: 1.1, opacity: 1 },
        { color: '#55340F', x: 0.12, y: 0.84, size: 1.0, opacity: 1 }
      ]
    }
  },
  graphite: {
    light: {
      base: ['#EFF1F5', '#DFE3EB', '#CFD5E0'],
      blooms: [
        { color: '#FFFFFF', x: 0.06, y: 0.02, size: 1.3, opacity: 0.92 },
        { color: '#D7DCE6', x: 0.84, y: 0.08, size: 1.2, opacity: 1 },
        { color: '#C8CFDC', x: 0.96, y: 0.86, size: 1.05, opacity: 1 },
        { color: '#DDE2EB', x: 0.14, y: 0.84, size: 1.0, opacity: 1 }
      ]
    },
    dark: {
      base: ['#171B22', '#12151B', '#0D0F14'],
      blooms: [
        { color: '#2B313C', x: 0.8, y: 0.06, size: 1.2, opacity: 1 },
        { color: '#232831', x: 0.96, y: 0.86, size: 1.1, opacity: 0.5 },
        { color: '#262C36', x: 0.12, y: 0.84, size: 1.0, opacity: 1 }
      ]
    }
  }
}

export const WALLPAPER_ORDER: readonly WallpaperName[] = ['blue', 'warm', 'graphite']

export const DEFAULT_WALLPAPER: WallpaperName = 'blue'

/**
 * Glass, as a recipe rather than as a picture.
 *
 * A glass surface is a blur, one or two translucent gradients, a hairline and a
 * drop shadow. Alphas are what make it legible, so they are tokens. Each variant
 * also names the OPAQUE colour it collapses to where there is no blur —
 * Android, Reduce Transparency, and a test renderer — which is the reason the
 * elevation ladder exists.
 */
export type GlassVariant = 'panel' | 'float' | 'sheet' | 'card' | 'row' | 'rowSelected' | 'control' | 'chip'

export type GlassRecipe = {
  /** Overlay gradient stops, top-left → bottom-right. Drawn over `solid`. */
  gradient: readonly string[]
  /** What the surface is where no blur is possible. A rung of the ladder. */
  solid: string
  /** `expo-blur` intensity, 0–100, mapped from the CSS blur radius. */
  blurIntensity: number
  /** Tint handed to the native Liquid Glass material, or none. */
  nativeTint?: string
  hairline: string
}

export type GlassScale = Record<GlassVariant, GlassRecipe>

export const lightGlass: GlassScale = {
  panel: {
    gradient: ['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.48)', 'rgba(255,255,255,0.60)'],
    solid: lightElevation.e1,
    blurIntensity: 80,
    hairline: 'rgba(16,38,78,0.08)'
  },
  float: {
    gradient: ['rgba(255,255,255,0.80)', 'rgba(255,255,255,0.58)'],
    solid: lightElevation.e3f,
    blurIntensity: 60,
    hairline: 'rgba(16,38,78,0.08)'
  },
  sheet: {
    gradient: ['rgba(255,255,255,0.86)', 'rgba(255,255,255,0.72)'],
    solid: lightElevation.e3,
    blurIntensity: 95,
    hairline: 'rgba(16,38,78,0.08)'
  },
  card: {
    gradient: ['rgba(255,255,255,0.70)', 'rgba(255,255,255,0.52)'],
    solid: lightElevation.e3c,
    blurIntensity: 50,
    hairline: 'rgba(16,38,78,0.08)'
  },
  row: {
    gradient: ['rgba(255,255,255,0.34)', 'rgba(255,255,255,0.34)'],
    solid: lightElevation.e2,
    blurIntensity: 0,
    hairline: 'transparent'
  },
  rowSelected: {
    gradient: ['rgba(255,255,255,0.62)', 'rgba(255,255,255,0.52)'],
    solid: lightElevation.e2s,
    blurIntensity: 0,
    hairline: 'rgba(16,38,78,0.08)'
  },
  control: {
    gradient: ['rgba(255,255,255,0.80)', 'rgba(255,255,255,0.58)'],
    solid: lightElevation.e4,
    blurIntensity: 45,
    hairline: 'rgba(16,38,78,0.08)'
  },
  chip: {
    gradient: ['rgba(255,255,255,0.52)', 'rgba(255,255,255,0.52)'],
    solid: lightElevation.e4,
    blurIntensity: 0,
    hairline: 'rgba(16,38,78,0.08)'
  }
}

export const darkGlass: GlassScale = {
  panel: {
    gradient: ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.03)', 'rgba(255,255,255,0.07)'],
    solid: darkElevation.e1,
    blurIntensity: 80,
    nativeTint: 'rgba(28,42,69,0.80)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  float: {
    gradient: ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.05)'],
    solid: darkElevation.e3f,
    blurIntensity: 60,
    nativeTint: 'rgba(66,90,136,0.74)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  sheet: {
    gradient: ['rgba(255,255,255,0.11)', 'rgba(255,255,255,0.04)'],
    solid: darkElevation.e2s,
    blurIntensity: 95,
    nativeTint: 'rgba(51,70,112,0.92)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  card: {
    gradient: ['rgba(255,255,255,0.09)', 'rgba(255,255,255,0.035)'],
    solid: darkElevation.e3c,
    blurIntensity: 50,
    nativeTint: 'rgba(47,64,102,0.86)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  row: {
    gradient: ['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.07)'],
    solid: darkElevation.e2,
    blurIntensity: 0,
    hairline: 'transparent'
  },
  rowSelected: {
    gradient: ['rgba(255,255,255,0.14)', 'rgba(255,255,255,0.06)'],
    solid: darkElevation.e2s,
    blurIntensity: 0,
    hairline: 'rgba(190,212,255,0.13)'
  },
  control: {
    gradient: ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.05)'],
    solid: darkElevation.e4,
    blurIntensity: 45,
    nativeTint: 'rgba(80,105,154,0.70)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  chip: {
    gradient: ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.12)'],
    solid: darkElevation.e4,
    blurIntensity: 0,
    hairline: 'rgba(190,212,255,0.13)'
  }
}

/**
 * Bubbles.
 *
 * A bubble is NOT a `GlassSurface`. §7.4 of the token document is explicit: a
 * virtualised list with a blur view per row is the fastest way to make a long
 * report scroll badly, and on Android there are no per-bubble blur views at all.
 * So an incoming bubble is the glass RECIPE composited by hand — gradient over a
 * rung — and a long reply drops the gradient for the near-opaque `read` wash so
 * its contrast is a fixed number rather than a function of the wallpaper.
 *
 * `tail` is the flat colour the SVG tail is filled with. It has to match the
 * bubble's LOWER edge, which for a translucent gradient means the composite
 * rather than the stop: these are the stops resolved against the panel they sit
 * on, so the tail meets the bubble with no visible seam.
 */
export type BubbleVariant = 'in' | 'inRead' | 'dm' | 'dmRead'

export type BubbleRecipe = {
  gradient: readonly [string, string]
  /** What the gradient composites onto where nothing behind it shows through. */
  solid: string
  tail: string
}

export const lightBubbles: Record<BubbleVariant, BubbleRecipe> = {
  in: { gradient: ['rgba(255,255,255,0.76)', 'rgba(244,248,255,0.64)'], solid: '#FFFFFF', tail: '#F1F5FE' },
  inRead: { gradient: ['rgba(255,255,255,0.93)', 'rgba(243,247,255,0.88)'], solid: '#FFFFFF', tail: '#F5F8FE' },
  dm: { gradient: ['rgba(243,238,255,0.88)', 'rgba(235,229,253,0.80)'], solid: '#FFFFFF', tail: '#EFE9FC' },
  dmRead: { gradient: ['rgba(243,238,255,0.96)', 'rgba(235,229,253,0.94)'], solid: '#FFFFFF', tail: '#ECE6FB' }
}

export const darkBubbles: Record<BubbleVariant, BubbleRecipe> = {
  in: { gradient: ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.035)'], solid: darkElevation.e3, tail: '#415881' },
  inRead: { gradient: ['rgba(255,255,255,0.08)', 'rgba(255,255,255,0.03)'], solid: darkElevation.e3, tail: '#405780' },
  dm: { gradient: ['rgba(140,110,255,0.16)', 'rgba(140,110,255,0.08)'], solid: '#413470', tail: '#453977' },
  dmRead: { gradient: ['rgba(140,110,255,0.14)', 'rgba(140,110,255,0.07)'], solid: '#413470', tail: '#443876' }
}

/**
 * The tail, as ONE path that belongs to the bubble.
 *
 * 13 × 17, drawn for the sender's side and mirrored with `scaleX(-1)` for the
 * other. It is offset `TAIL_OVERLAP` into the bubble so it covers the 6pt
 * sender-side bottom corner rather than sitting beside it. There is deliberately
 * no separately positioned tail VIEW: the previous build drew the tail as an
 * absolutely positioned square with one rounded corner, and at certain bubble
 * heights the square's straight corners escaped the bubble's own rounding and
 * painted the stray block the owner reported. A path cannot do that.
 */
export const TAIL = { width: 13, height: 17, path: 'M0 0 L5 0 C5 7 7.6 13.4 13 16 C8.4 17.7 3 16 0 12.4 Z' } as const

export const TAIL_OVERLAP = 6

/**
 * Max bubble width — the rule that fixes edge-to-edge text walls.
 *
 * 68 % is too narrow to read at phone width, hence the override; the 640pt cap
 * is what keeps a long report from spanning a Mac window.
 */
export const BUBBLE_MAX = {
  regular: { percent: 68, points: 640 },
  compact: { percent: 78, points: 320 }
} as const

export type ResolvedBubbleWidth = (typeof BUBBLE_MAX)[keyof typeof BUBBLE_MAX]

/**
 * Where a long reply folds.
 *
 * Fourteen lines at the reading leading, which is the number the mockup folds
 * at. Expressed in POINTS because that is what `maxHeight` takes, and derived
 * from the leading so the two cannot drift: 14 × 27 ≈ 378 on the wide layout,
 * and the phone folds sooner because its bubble is narrower and therefore its
 * fourteen lines hold less.
 */
export const FOLD_HEIGHT = { regular: 378, compact: 300 } as const

/** How many consecutive bubbles from one sender sit this far apart. */
export const BUBBLE_GAP = { grouped: 3, separate: 10 } as const

/** A sunk surface: a search field, a code well, the tab strip's track. */
export const TINT_SUNK: Record<Scheme, string> = {
  light: 'rgba(14,32,64,0.055)',
  dark: 'rgba(6,12,24,0.44)'
}

/** The full-strength hairline, for an edge that has to be visible. */
export const HAIRLINE: Record<Scheme, string> = {
  light: 'rgba(16,38,78,0.13)',
  dark: 'rgba(190,212,255,0.22)'
}

export const HAIRLINE_SOFT: Record<Scheme, string> = {
  light: 'rgba(16,38,78,0.08)',
  dark: 'rgba(190,212,255,0.13)'
}

/**
 * The specular inner edge that makes a surface read as glass rather than as a
 * flat translucent rectangle. React Native has no inset shadow, so it is drawn
 * as a 1pt border of the first stop's colour — the strongest of the three CSS
 * lines, and the only one that survives being flattened to a border.
 */
export const EDGE: Record<Scheme, string> = {
  light: 'rgba(255,255,255,0.92)',
  dark: 'rgba(255,255,255,0.34)'
}

export const EDGE_SOFT: Record<Scheme, string> = {
  light: 'rgba(255,255,255,0.80)',
  dark: 'rgba(255,255,255,0.24)'
}

export type ShadowToken = {
  shadowColor: string
  shadowOffset: { width: number; height: number }
  shadowOpacity: number
  shadowRadius: number
  /** Android has one number for all of it. */
  elevation: number
}

export type ShadowName = 'panel' | 'float' | 'card' | 'sheet'

export type ShadowScale = Record<ShadowName, ShadowToken>

export const lightShadows: ShadowScale = {
  panel: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.28,
    shadowRadius: 32,
    elevation: 16
  },
  float: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 15,
    elevation: 8
  },
  card: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 3
  },
  sheet: {
    shadowColor: '#0E2856',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.24,
    shadowRadius: 30,
    elevation: 20
  }
}

export const darkShadows: ShadowScale = {
  panel: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.62,
    shadowRadius: 35,
    elevation: 16
  },
  float: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8
  },
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.38,
    shadowRadius: 8,
    elevation: 3
  },
  sheet: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.55,
    shadowRadius: 30,
    elevation: 20
  }
}

/** The dimmed layer an overlay panel or a sheet puts over what it covers. */
export const SCRIM_COLOR = 'rgba(8,20,44,0.34)'

/**
 * Motion.
 *
 * The rule that matters more than the numbers: **animation is reserved for
 * things that need the reader.** The only presence state that animates is
 * "needs input" — a 2s, low-amplitude amber ring pulse. Working is static; a bot
 * being busy is information, not a request. Under Reduce Motion every duration
 * collapses to zero and the pulse resolves to a static ring.
 */
export const motion = {
  micro: 120,
  fast: 180,
  base: 260,
  sheet: 420,
  /** The "needs input" pulse, the one loop in the app. */
  pulse: 2000
} as const

/** Main controls are 44pt or taller, per the design board's touch-target rule. */
export const CONTROL_MIN_HEIGHT = 44

/** Round glass control: 38 on the wide layout, 40 on phone. */
export const CONTROL_SIZE = { regular: 38, compact: 40 } as const

export const AVATAR_SIZE = { list: 48, header: 38, inline: 26 } as const

/** List row height: 74 on the wide layout, 72 on phone. */
export const ROW_HEIGHT = { regular: 74, compact: 72 } as const

/**
 * The slop that brings a small inline control up to a 44pt target.
 *
 * A caption-sized "Show more" or "Stop" is roughly 17pt tall. Growing the box
 * would push the card's layout around, so the touchable area is grown instead
 * — which is what `hitSlop` is for, and the only way these rows reach the
 * touch-target rule without being redrawn.
 */
export const TAP_SLOP = { bottom: 14, left: 12, right: 12, top: 14 } as const

/** The width at and above which the regular (sidebar + detail) shell is used. */
export const REGULAR_LAYOUT_MIN_WIDTH = 700

/** Sidebar width in the regular shell, in points. */
export const SIDEBAR_WIDTH = 344

/** How wide the overlay panel grows before it starts leaving the sidebar room. */
export const OVERLAY_MAX_WIDTH = 520

/**
 * How wide a bottom sheet grows on the wide layout.
 *
 * A sheet spanning a 1366pt window puts "Allow once" and "Deny" a hand's width
 * apart, and lays its scrim over the chat list the reader is still using. It is
 * capped and parked over the content column instead — see `sheetBox` in
 * `src/ui/BottomSheet.tsx`.
 */
export const SHEET_MAX_WIDTH = 560

/**
 * An onboarding form never grows past this; a centred column reads better than
 * a full-width field on an iPad or a Mac window.
 */
export const FORM_MAX_WIDTH = 480

/**
 * `#RRGGBB` plus an alpha, as `rgba()`.
 *
 * React Native accepts `#RRGGBBAA` on both platforms, but a token that is read
 * back and compared in a test is easier to reason about as an `rgba()` string,
 * and the mockup writes them that way too.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map(char => char + char)
          .join('')
      : value
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)

  return `rgba(${r},${g},${b},${alpha})`
}
