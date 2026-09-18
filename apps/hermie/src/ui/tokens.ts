// Design tokens. Everything visual resolves through here so that the macOS and
// mobile shells cannot drift apart, and so a future theme is a data change.

export type ColorRole = 'bg' | 'surface' | 'surfaceRaised' | 'text' | 'textMuted' | 'accent' | 'danger' | 'border'

export type ColorScale = Record<ColorRole, string>

export const lightColors: ColorScale = {
  bg: '#FFFFFF',
  surface: '#F5F6F8',
  surfaceRaised: '#FFFFFF',
  text: '#0B0D10',
  textMuted: '#5B6470',
  accent: '#3A63D8',
  danger: '#B3261E',
  border: '#DCE0E6'
}

export const darkColors: ColorScale = {
  bg: '#0B0D10',
  surface: '#14181D',
  surfaceRaised: '#1C2127',
  text: '#F2F4F7',
  textMuted: '#9AA4B2',
  accent: '#7C9CFF',
  danger: '#F2887F',
  border: '#2A3039'
}

// 4pt scale. `space.md` is the default gap between unrelated blocks.
export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48
} as const

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999
} as const

export type TypeStyle = {
  fontSize: number
  lineHeight: number
  fontWeight: '400' | '500' | '600' | '700'
}

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '400' }
} as const satisfies Record<string, TypeStyle>

export type TypeToken = keyof typeof type

// The width at and above which the regular (sidebar + detail) shell is used.
export const REGULAR_LAYOUT_MIN_WIDTH = 700

// Sidebar width in the regular shell, in points.
export const SIDEBAR_WIDTH = 320
