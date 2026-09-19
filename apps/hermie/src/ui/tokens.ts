// Design tokens. Everything visual resolves through here so that the macOS and
// mobile shells cannot drift apart, and so a future theme is a data change.
//
// The values are the Messenger direction from `design/tokens.md`: an
// iMessage/Telegram feel, system sans, and blue bubble shades deliberately
// deeper than the platform default so white body text keeps AA contrast.

export type ColorRole =
  | 'bg'
  | 'surface'
  | 'surfaceRaised'
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'bubbleBlue'
  | 'onAccent'
  | 'danger'
  | 'success'
  | 'switchGreen'
  | 'border'
  | 'incoming'
  | 'incomingText'

export type ColorScale = Record<ColorRole, string>

export const lightColors: ColorScale = {
  bg: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceRaised: '#E9E9ED',
  text: '#17171B',
  textMuted: '#5C5C65',
  accent: '#0063CC',
  bubbleBlue: '#006BDC',
  onAccent: '#FFFFFF',
  danger: '#B42332',
  success: '#217844',
  switchGreen: '#238548',
  border: '#D5D5DC',
  incoming: '#EEE8F7',
  incomingText: '#61428B'
}

export const darkColors: ColorScale = {
  bg: '#000000',
  surface: '#111113',
  surfaceRaised: '#28282C',
  text: '#F5F5F7',
  textMuted: '#B0B0BA',
  accent: '#62ACFF',
  bubbleBlue: '#0874DE',
  onAccent: '#FFFFFF',
  danger: '#FF9AA4',
  success: '#76D995',
  switchGreen: '#238548',
  border: '#3C3C43',
  incoming: '#30253F',
  incomingText: '#D1B6F5'
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
  bubble: 20,
  sheet: 28,
  pill: 999
} as const

export type TypeStyle = {
  fontSize: number
  lineHeight: number
  fontWeight: '400' | '500' | '600' | '700'
}

export const type = {
  display: { fontSize: 24, lineHeight: 28, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 26, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 25, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: '400' },
  micro: { fontSize: 11, lineHeight: 15, fontWeight: '400' },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '400' }
} as const satisfies Record<string, TypeStyle>

export type TypeToken = keyof typeof type

// Main controls are 44pt or taller, per the design board's touch-target rule.
export const CONTROL_MIN_HEIGHT = 44

/**
 * The slop that brings a small inline control up to a 44pt target.
 *
 * A caption-sized "Show more" or "Stop" is roughly 17pt tall. Growing the box
 * would push the card's layout around, so the touchable area is grown instead
 * — which is what `hitSlop` is for, and the only way these rows reach the
 * touch-target rule without being redrawn.
 */
export const TAP_SLOP = { bottom: 14, left: 12, right: 12, top: 14 } as const

// The width at and above which the regular (sidebar + detail) shell is used.
export const REGULAR_LAYOUT_MIN_WIDTH = 700

// Sidebar width in the regular shell, in points.
export const SIDEBAR_WIDTH = 320

// An onboarding form never grows past this; a centred column reads better than
// a full-width field on an iPad or a Mac window.
export const FORM_MAX_WIDTH = 480
