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
  /**
   * A speech bubble's outer corner.
   *
   * 18. It was 22 once, which on a bubble whose content box is 10pt tall left the
   * corner arc taller than the text it surrounds — a one-word message read as a
   * lozenge rather than as a bubble. 16 fixed that and undershot the reference
   * the owner is holding this against; 18 is the radius that goes with the
   * droplet tail below.
   */
  bubble: 18,
  sheet: 28,
  panel: 30,
  pill: 999,
  /**
   * The tail-side corner: where the tail meets the bubble, and where two bubbles
   * of one run meet each other.
   *
   * One number for both because they are the same corner seen from either end of
   * a run — see `Bubble`'s corner table.
   */
  tail: 4
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
export type AccentName =
  'default' | 'indigo' | 'violet' | 'magenta' | 'red' | 'orange' | 'teal' | 'green' | 'graphite' | 'slate'

export type AccentSwatch = {
  /** Solid fill: the avatar ring, the swatch itself. */
  fill: string
  /** Readable on glass. Scheme-dependent. */
  text: { light: string; dark: string }
  /**
   * The outgoing bubble's fill. ONE colour.
   *
   * It was a two-stop gradient and the owner's verdict on gradients is that they
   * look generated. Flat is also what every messenger he compared this to draws:
   * one saturated field, one ink on it. The value kept is the gradient's lighter
   * stop, which is the one `contrast:check` has always measured white against —
   * so the accent that was hardest to read on is now the whole bubble, and the
   * floor did not move.
   */
  bubble: string
}

export const ACCENTS: Record<AccentName, AccentSwatch> = {
  default: {
    fill: '#1668E3',
    text: { light: '#0B57C4', dark: '#B4D6FF' },
    bubble: '#2A72DC'
  },
  indigo: {
    fill: '#4B4CC8',
    text: { light: '#3F3FB4', dark: '#CCCDFF' },
    bubble: '#5556CE'
  },
  violet: {
    fill: '#7B3FC4',
    text: { light: '#6A2FB4', dark: '#E0C8FF' },
    bubble: '#8244CE'
  },
  magenta: {
    fill: '#B62F81',
    text: { light: '#A22270', dark: '#FFC2E2' },
    bubble: '#C0368A'
  },
  red: {
    fill: '#C5303A',
    text: { light: '#AE2029', dark: '#FFC2C7' },
    bubble: '#CF3B44'
  },
  orange: {
    fill: '#B04C08',
    text: { light: '#9A4106', dark: '#FFD0A8' },
    bubble: '#B8540C'
  },
  teal: {
    fill: '#0E7A84',
    text: { light: '#0A6670', dark: '#A6E8EE' },
    bubble: '#14828C'
  },
  green: {
    fill: '#16783C',
    text: { light: '#12652F', dark: '#A8ECBE' },
    bubble: '#1A8043'
  },
  graphite: {
    fill: '#485468',
    text: { light: '#3D4859', dark: '#D2DAE6' },
    bubble: '#54607A'
  },
  /**
   * Slate: the Slate wallpaper's own outgoing bubble.
   *
   * A desaturated BLUE, which is what makes it a different swatch from Graphite
   * rather than a second name for it: Graphite is grey with a hint of blue in it
   * (`#54607A`), and this is blue with most of the blue taken out (`#4F6B96`). Side
   * by side on the picker they read as two different answers to the same question,
   * which is the only reason to have both.
   *
   * The top stop IS the value the owner sampled, and it is the stop white has to be
   * readable on — so nothing lighter can be added above it without the contrast
   * check saying so.
   */
  slate: {
    fill: '#4F6B96',
    text: { light: '#3F5A83', dark: '#C6D8F2' },
    bubble: '#4F6B96'
  }
}

/** Picker order: Default first, then the curated colours. */
export const ACCENT_ORDER: readonly AccentName[] = [
  'default',
  'indigo',
  'violet',
  'magenta',
  'red',
  'orange',
  'teal',
  'green',
  'graphite',
  'slate'
]

/** The soft tint a chat's colour lays under a selected row or an icon well. */
export function accentSoft(name: AccentName, scheme: Scheme): string {
  return withAlpha(ACCENTS[name].fill, scheme === 'dark' ? 0.26 : 0.13)
}

/**
 * Wallpapers: four, each with a light and a dark variant, one flat colour each.
 *
 * No image files, and since this round no gradients either. Each spec used to be
 * a diagonal ramp plus four or five corner blooms, built to imitate the mockup's
 * radial washes. The owner's verdict on the result was that it looks generated,
 * and the benchmark he set — iPadOS 26 Messages in dark mode — is a near-black
 * field with nothing painted on it: everything that looks like depth there comes
 * from the glass in front, not from the floor.
 *
 * So each variant keeps the end of its old ramp that is FARTHEST from the ink —
 * the palest stop in light, the deepest in dark. Dark wallpapers stay COLOURED
 * rather than `#000000`; `#070F1D` is a near-black blue, and that difference is
 * still the whole point of having four of them.
 *
 * ### A wallpaper may name its own accent
 *
 * `accent` is what "Default" resolves to while that wallpaper is on. It exists for
 * exactly one reason: a wallpaper is the only setting a reader picks that is
 * supposed to change the whole COMPOSITION, and the outgoing bubble is the largest
 * saturated thing in that composition. A desaturated wallpaper with the stock blue
 * bubble on it is not a desaturated window; it is a grey window with a blue stripe
 * down one side.
 *
 * It only ever replaces the DEFAULT. A chat whose colour the reader chose keeps it,
 * because that choice is about that conversation and not about the wallpaper.
 */
export type WallpaperName = 'blue' | 'warm' | 'graphite' | 'slate'

export type WallpaperSpec = {
  /** The whole floor. One colour — see the note above. */
  fill: string
  /** What "Default" resolves to while this wallpaper is on. See the note above. */
  accent?: AccentName
}

export const WALLPAPERS: Record<WallpaperName, Record<Scheme, WallpaperSpec>> = {
  blue: {
    light: {
      fill: '#EAF3FF'
    },
    dark: {
      fill: '#070F1D'
    }
  },
  warm: {
    light: {
      fill: '#FFF3E6'
    },
    dark: {
      fill: '#160C05'
    }
  },
  graphite: {
    light: {
      fill: '#EFF1F5'
    },
    dark: {
      fill: '#0D0F14'
    }
  },
  /**
   * Slate: the desaturated composition.
   *
   * ### Why it is not Graphite
   *
   * Graphite was compared first, and it is a different thing. It is `#0D0F14`: a
   * near-black wallpaper, where every panel on it is a pale shape floating in the
   * dark and the contrast between the window and its contents is the loudest thing
   * on screen. Slate is `#2E3640` — about three times the luminance — so the panels
   * sit a step above their background rather than a chasm above it, and the whole
   * window reads as one desaturated grey-blue object. That is the rendering the
   * owner asked for, and it is the FLOOR that produces it, which is why the two
   * cannot be tuned into each other.
   *
   * ### Why the panels are not listed here
   *
   * They are the glass recipe over this colour, which is how every surface in this app
   * gets its colour: `panel` is a 3–10 % white wash, so over `#3B4552` it composites
   * to about `#434D5A`, a card to about `#4B5563`, a control higher again. Those are
   * the values the owner sampled off a desaturated window, and they fall out of the
   * wallpaper rather than needing a second elevation ladder beside the first. The
   * ladder in this file is the OPAQUE fallback — Android, Reduce Transparency, a test
   * renderer — and it is scheme-wide, not per wallpaper; `design/README.md` records
   * that Slate under Reduce Transparency therefore falls back to the shared rungs.
   *
   * ### The ceiling on the blooms is a contrast ceiling
   *
   * `npm run contrast:check` measures every ink against the BRIGHTEST point of every
   * dark wallpaper, and the dark ink set is calibrated against a deep one. `#3B4552`
   * is already about as bright as the Blue wallpaper's worst bloom, so nothing here
   * may go above it — the blooms are hue shifts at the same luminance, not
   * highlights. A brighter bloom does not look better; it fails the check.
   */
  slate: {
    light: {
      accent: 'slate',
      fill: '#EEF0F3'
    },
    dark: {
      accent: 'slate',
      fill: '#2E3640'
    }
  }
}

export const WALLPAPER_ORDER: readonly WallpaperName[] = ['blue', 'warm', 'graphite', 'slate']

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
  /**
   * The translucent wash over `solid`. ONE colour.
   *
   * It was a two- or three-stop gradient, and the owner's verdict on gradients
   * is that they look generated. The value kept is the THINNEST stop — the one
   * the wallpaper showed through most — because that is the stop
   * `contrast:check` has always measured the ink against, so making it the whole
   * surface cannot lower a single ratio in the table.
   */
  fill: string
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
    fill: 'rgba(255,255,255,0.48)',
    solid: lightElevation.e1,
    blurIntensity: 80,
    hairline: 'rgba(16,38,78,0.08)'
  },
  float: {
    fill: 'rgba(255,255,255,0.58)',
    solid: lightElevation.e3f,
    blurIntensity: 60,
    hairline: 'rgba(16,38,78,0.08)'
  },
  sheet: {
    fill: 'rgba(255,255,255,0.72)',
    solid: lightElevation.e3,
    blurIntensity: 95,
    hairline: 'rgba(16,38,78,0.08)'
  },
  card: {
    fill: 'rgba(255,255,255,0.52)',
    solid: lightElevation.e3c,
    blurIntensity: 50,
    hairline: 'rgba(16,38,78,0.08)'
  },
  row: {
    fill: 'rgba(255,255,255,0.34)',
    solid: lightElevation.e2,
    blurIntensity: 0,
    hairline: 'transparent'
  },
  rowSelected: {
    fill: 'rgba(255,255,255,0.52)',
    solid: lightElevation.e2s,
    blurIntensity: 0,
    hairline: 'rgba(16,38,78,0.08)'
  },
  control: {
    fill: 'rgba(255,255,255,0.58)',
    solid: lightElevation.e4,
    blurIntensity: 45,
    hairline: 'rgba(16,38,78,0.08)'
  },
  chip: {
    fill: 'rgba(255,255,255,0.52)',
    solid: lightElevation.e4,
    blurIntensity: 0,
    hairline: 'rgba(16,38,78,0.08)'
  }
}

export const darkGlass: GlassScale = {
  panel: {
    fill: 'rgba(255,255,255,0.03)',
    solid: darkElevation.e1,
    blurIntensity: 80,
    nativeTint: 'rgba(28,42,69,0.80)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  float: {
    fill: 'rgba(255,255,255,0.05)',
    solid: darkElevation.e3f,
    blurIntensity: 60,
    nativeTint: 'rgba(66,90,136,0.74)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  sheet: {
    fill: 'rgba(255,255,255,0.04)',
    solid: darkElevation.e2s,
    blurIntensity: 95,
    nativeTint: 'rgba(51,70,112,0.92)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  card: {
    fill: 'rgba(255,255,255,0.035)',
    solid: darkElevation.e3c,
    blurIntensity: 50,
    nativeTint: 'rgba(47,64,102,0.86)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  row: {
    fill: 'rgba(255,255,255,0.07)',
    solid: darkElevation.e2,
    blurIntensity: 0,
    hairline: 'transparent'
  },
  rowSelected: {
    fill: 'rgba(255,255,255,0.06)',
    solid: darkElevation.e2s,
    blurIntensity: 0,
    hairline: 'rgba(190,212,255,0.13)'
  },
  control: {
    fill: 'rgba(255,255,255,0.05)',
    solid: darkElevation.e4,
    blurIntensity: 45,
    nativeTint: 'rgba(80,105,154,0.70)',
    hairline: 'rgba(190,212,255,0.13)'
  },
  chip: {
    fill: 'rgba(255,255,255,0.12)',
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
  /** The translucent wash over `solid`. One colour — see `GlassRecipe.fill`. */
  fill: string
  /** What the wash composites onto where nothing behind it shows through. */
  solid: string
  tail: string
}

export const lightBubbles: Record<BubbleVariant, BubbleRecipe> = {
  in: { fill: 'rgba(244,248,255,0.64)', solid: '#FFFFFF', tail: '#F1F5FE' },
  inRead: { fill: 'rgba(243,247,255,0.88)', solid: '#FFFFFF', tail: '#F5F8FE' },
  dm: { fill: 'rgba(235,229,253,0.80)', solid: '#FFFFFF', tail: '#EFE9FC' },
  dmRead: { fill: 'rgba(235,229,253,0.94)', solid: '#FFFFFF', tail: '#ECE6FB' }
}

export const darkBubbles: Record<BubbleVariant, BubbleRecipe> = {
  in: { fill: 'rgba(255,255,255,0.035)', solid: darkElevation.e3, tail: '#415881' },
  inRead: { fill: 'rgba(255,255,255,0.03)', solid: darkElevation.e3, tail: '#405780' },
  dm: { fill: 'rgba(140,110,255,0.08)', solid: '#413470', tail: '#453977' },
  dmRead: { fill: 'rgba(140,110,255,0.07)', solid: '#413470', tail: '#443876' }
}

/**
 * The tail, as ONE path that belongs to the bubble: the classic droplet.
 *
 * 20 × 25, drawn for the sender's side and mirrored with `scaleX(-1)` for the
 * other. It is offset `TAIL_OVERLAP` into the bubble, so within this box the
 * bubble's own edge stands at x = 13 and the tail reaches 7 past it. There is
 * deliberately no separately positioned tail VIEW: the build before last drew the
 * tail as an absolutely positioned square with one rounded corner, and at certain
 * bubble heights the square's straight corners escaped the bubble's own rounding
 * and painted the stray block the owner reported. A path cannot do that.
 *
 * ### Where the numbers come from
 *
 * The shape is the one the well-known CSS construction produces, resolved to a
 * single closed outline because our backgrounds are glass and a
 * background-coloured mask over glass is a grey patch, not a cut. That
 * construction is two boxes 25 tall sitting on the bubble's bottom edge: a piece
 * of bubble colour reaching 7 past the edge, and a background-coloured piece
 * starting AT the edge whose 10pt bottom-left rounding cuts the curl. What
 * survives the cut is the only part that was ever visible, and it is this path:
 *
 *  - `13,15 → 20,25` is that 10pt cut, as an arc. It is the tail's whole visible
 *    silhouette — a concave edge leaving the bubble 10pt above its bottom,
 *    sweeping down and out to a point on the bubble's own bottom line, 7 out.
 *  - the rest is behind the bubble and exists only so the shape is closed and
 *    covers what it must.
 *
 * ### The underside is flat to x = 6, and that is not a simplification
 *
 * The colour piece's own bottom-left rounding is wide (16 × 14), which lifts the
 * outline off the bubble's bottom line well before the bubble's body is there to
 * hide it: the bubble's tail-side bottom corner is `radii.tail`, so between the
 * end of that corner arc and the bubble's bottom line there is a wedge the bubble
 * does NOT paint. With a wide curl the tail does not paint it either, and the gap
 * reads as a notch under the corner — which is the same artefact, by a different
 * route, that the positioned-square tail was replaced for. So the outline stays
 * on the bottom line until x = 6, which is comfortably inside the corner, and
 * tucks up from there where only the bubble can see it.
 *
 * Every number is whole. The Mac renders the iPad build scaled, so a sub-point
 * offset that is invisible at 3x is a visible sliver there.
 */
export const TAIL = {
  width: 20,
  height: 25,
  path: 'M0 0 L13 0 L13 15 A10 10 0 0 0 20 25 L6 25 A6 14 0 0 1 0 11 Z'
} as const

export const TAIL_OVERLAP = 13

/**
 * Max bubble width — the rule that fixes edge-to-edge text walls.
 *
 * 68 % is too narrow to read at phone width, hence the override; the 640pt cap
 * is what keeps a long report from spanning a Mac window.
 *
 * **`widePoints` is a second ceiling, for a column wide enough that the first one
 * looks mean.** 640pt is a comfortable measure, and on a 13" iPad in landscape or
 * a full-screen Mac window the content column is around 1500pt — so a capped
 * bubble uses under half of it and the transcript reads as a narrow strip with a
 * large empty margin, which is what the owner reported. Above `wideColumnFrom`
 * the ceiling steps to 760: still a measure rather than a wall (about 85
 * characters at the reading size), and still far short of the column. The step is
 * deliberately a step and not a curve — a bubble that grows continuously with the
 * window changes width every time the sidebar is collapsed, and a measure that
 * moves while you read is worse than one that is slightly wrong.
 */
export const BUBBLE_MAX = {
  regular: { percent: 68, points: 640, widePoints: 760, wideColumnFrom: 1100 },
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

/**
 * The same fold, as a LINE COUNT — which is the number that actually matters.
 *
 * A fold clipped to a height lands wherever that height falls, and half a line
 * of x-height under a gradient reads as a sliced row rather than as a fade. So
 * the clip is `lines × leading` and the leading is the one the caller is really
 * rendering at, which only the caller knows. `FOLD_HEIGHT` stays the fallback
 * for a body whose leading nobody has told us.
 */
export const FOLD_LINES = { regular: 14, compact: 11 } as const

/**
 * How many lines the fade covers.
 *
 * One line is not a fade, it is an edge; four is a wash that hides a paragraph
 * the reader could have read. Two and a half lines is long enough to be plainly
 * a gradient at both leadings.
 */
export const FOLD_FADE_LINES = 2.5

/**
 * How far apart two bubbles sit: within one sender's run, and between two turns.
 *
 * The ratio is what makes a run read as one block rather than as four separate
 * rounded rectangles — the small gap is "the same person, still talking" and the
 * separate one is "somebody else now".
 *
 * Both numbers moved this round, to the proportions the owner was comparing
 * against. 3pt was too tight to be a gap at all: two bubbles 3pt apart with a
 * 4pt tucked corner between them read as one bubble with a scratch across it, so
 * the run lost the thing the gap was for. And 12pt between two TURNS is the same
 * order of magnitude as the gap inside a run, which is why the grouping was hard
 * to see at a glance — 6 against 24 is a ratio a reader can resolve without
 * measuring, and 24 is what an author change needs to read as a paragraph break.
 */
export const BUBBLE_GAP = { grouped: 6, separate: 24 } as const

/**
 * The gap between a bubble's last text line and the time that sits on it.
 *
 * `space.sm`'s number, but its own token: this is a gap between two RUNS OF TEXT
 * sharing a line, not spacing between blocks, and the two have no reason to move
 * together. It is also the number a test has to be able to name.
 */
export const INLINE_META_GAP = 8

/**
 * Consecutive bot-to-bot lines, from §6.6.
 *
 * Deliberately its own number rather than a reuse of `BUBBLE_GAP.separate`. A
 * dispatch is a ledger line, not speech (§6.4): it has no tail and no corner to
 * tuck, so it neither groups like a bubble nor deserves the gap that separates
 * two turns of conversation. Nine is what sits between two of them.
 */
export const DM_LINE_GAP = 9

/** A sunk surface: a search field, a code well, the tab strip's track. */
export const TINT_SUNK: Record<Scheme, string> = {
  light: 'rgba(14,32,64,0.055)',
  dark: 'rgba(6,12,24,0.44)'
}

/**
 * The soft destructive fill, and the soft ok one beside it.
 *
 * §3's `.btn--danger` is a TINT carrying `dangerText`, not the saturated
 * `danger` fill. That is a hierarchy decision, not a shade: a sheet whose four
 * answers include one solid red block reads as a warning about itself rather
 * than as a choice between four buttons, and the solid fill is then competing
 * with the primary. `danger` stays what a status MARK is painted with.
 */
export const DANGER_SOFT: Record<Scheme, string> = {
  light: 'rgba(192,41,58,0.12)',
  dark: 'rgba(255,120,135,0.16)'
}

/**
 * The dark alpha is 0.12, not the 0.16 the danger tint uses.
 *
 * `ok` is the lightest of the status fills, so the same wash lifts a dark sheet
 * further — at 0.16 every light ink on it, `okText` included, measured 4.39–4.47
 * against the blue wallpaper's brightest bloom and `npm run contrast:check`
 * failed. Both tints are in that check now, which is how this was found at all.
 */
export const OK_SOFT: Record<Scheme, string> = {
  light: 'rgba(28,133,71,0.12)',
  dark: 'rgba(92,203,134,0.12)'
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

/**
 * Sidebar width in the regular shell, on a window wide enough to spare it.
 *
 * §4's number was 344 flat, which is a landscape number wearing no label. In
 * portrait it is a THIRD of an iPad Pro 13" (344 of 1032) and two fifths of an
 * 11" (344 of 834), and what it takes comes out of the one column that has to
 * hold prose.
 */
export const SIDEBAR_WIDTH = 340

/**
 * The same sidebar on a window that cannot spare it.
 *
 * A list row is an avatar, two lines of text and a stamp; at 300 the preview
 * loses a couple of words and nothing else, which is the cheapest 40pt the
 * layout has to give.
 */
export const SIDEBAR_WIDTH_NARROW = 300

/** Above this window width the sidebar takes `SIDEBAR_WIDTH`, below it the narrow one. */
export const SIDEBAR_WIDE_MIN_WIDTH = 1100

/**
 * The width band that decides whether the sidebar STARTS hidden.
 *
 * A THIRD breakpoint, and the reason it is its own number rather than a reuse of
 * either of the other two: 700 is "do two panels fit at all" and 1100 is "can the
 * wider sidebar be afforded", while this one is "is a 300pt list worth what it
 * costs the prose beside it". Measured, in the 2026-09-20 portrait pass: at 834pt
 * portrait the chat column keeps 492pt and the bubble cap lands around 335pt,
 * which is about 38 characters — short of a comfortable measure and the finding
 * that asked for a collapse in the first place. Above 900 there is enough left
 * over that starting hidden would be taking something away for nothing.
 *
 * It only ever answers for a window the owner has expressed NO opinion about; an
 * explicit Hide or Show wins at every width. See `resolveSidebarCollapsed`.
 */
export const SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH = 900

/**
 * The slim rail the collapsed sidebar leaves behind.
 *
 * Not zero, and that is the decision rather than an oversight: the rail keeps the
 * Show control and the three tab-strip destinations one tap away, so collapsing
 * the list costs the reader the list and nothing else. 56 is a 38pt round control
 * plus the panel's own hairline and breathing room on each side — narrow enough
 * that the swap is worth about 250pt of prose at the 834pt window this exists for.
 */
export const SIDEBAR_RAIL_WIDTH = 56

/**
 * Which of the two applies, as a function of the WINDOW.
 *
 * A function rather than a second constant at each call site: the shell, the
 * gallery's mimic of the shell and anything that parks itself beside the sidebar
 * have to agree, and three copies of one comparison is how they stop agreeing.
 */
export function sidebarWidth(windowWidth: number): number {
  return windowWidth >= SIDEBAR_WIDE_MIN_WIDTH ? SIDEBAR_WIDTH : SIDEBAR_WIDTH_NARROW
}

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
 * How wide the onboarding card grows before it stops.
 *
 * Wider than `FORM_MAX_WIDTH` because the card carries its own padding, its
 * status lines and its actions rather than only a field: at 480 the same content
 * wrapped one line more on every step. It is the wizard's whole width on a
 * phone, where the card spans the window minus the gap instead.
 */
export const ONBOARDING_CARD_MAX_WIDTH = 520

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
