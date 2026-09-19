import { StatusBar } from 'expo-status-bar'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AccessibilityInfo, useColorScheme } from 'react-native'

import { useSettingsStore } from '../store/settings'
import {
  ACCENTS,
  darkBubbles,
  darkColors,
  darkElevation,
  darkGlass,
  darkPresence,
  darkShadows,
  EDGE,
  EDGE_SOFT,
  HAIRLINE,
  HAIRLINE_SOFT,
  lightBubbles,
  lightColors,
  lightElevation,
  lightGlass,
  lightPresence,
  lightShadows,
  motion,
  radii,
  space,
  TINT_SUNK,
  type,
  WALLPAPERS,
  type AccentName,
  type AccentSwatch,
  type BubbleRecipe,
  type BubbleVariant,
  type ColorScale,
  type ElevationScale,
  type GlassScale,
  type PresenceScale,
  type Scheme,
  type ShadowScale,
  type WallpaperName,
  type WallpaperSpec
} from './tokens'

/** An accent with its scheme-dependent halves already resolved. */
export type ResolvedAccent = {
  name: AccentName
  fill: AccentSwatch['fill']
  text: string
  bubble: AccentSwatch['bubble']
  /** The wash under a selected row or an icon well. */
  soft: string
}

export type Theme = {
  scheme: Scheme
  colors: ColorScale
  elevation: ElevationScale
  glass: GlassScale
  /** Incoming bubbles: a hand-composited recipe, never a blur view per row. */
  bubbles: Record<BubbleVariant, BubbleRecipe>
  presence: PresenceScale
  shadows: ShadowScale
  wallpaper: WallpaperSpec
  wallpaperName: WallpaperName
  space: typeof space
  radii: typeof radii
  type: typeof type
  motion: typeof motion
  hairline: string
  hairlineSoft: string
  edge: string
  edgeSoft: string
  tintSunk: string
  /**
   * VoiceOver's "Reduce Transparency". Every glass surface swaps for its solid
   * tint and keeps the identical token set.
   */
  reduceTransparency: boolean
  /** "Reduce Motion". Durations collapse and the amber pulse goes static. */
  reduceMotion: boolean
  /** Resolve a chat's accent for this scheme. `undefined` means Default. */
  accent: (name?: AccentName) => ResolvedAccent
}

function resolveAccent(name: AccentName, scheme: Scheme): ResolvedAccent {
  const swatch = ACCENTS[name] ?? ACCENTS.default

  return {
    name,
    fill: swatch.fill,
    text: swatch.text[scheme],
    bubble: swatch.bubble,
    soft: accentSoftValue(swatch.fill, scheme)
  }
}

function accentSoftValue(fill: string, scheme: Scheme): string {
  const value = fill.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)

  return `rgba(${r},${g},${b},${scheme === 'dark' ? 0.26 : 0.13})`
}

function buildTheme(
  scheme: Scheme,
  wallpaperName: WallpaperName,
  reduceTransparency: boolean,
  reduceMotion: boolean
): Theme {
  const dark = scheme === 'dark'

  return {
    scheme,
    colors: dark ? darkColors : lightColors,
    elevation: dark ? darkElevation : lightElevation,
    glass: dark ? darkGlass : lightGlass,
    bubbles: dark ? darkBubbles : lightBubbles,
    presence: dark ? darkPresence : lightPresence,
    shadows: dark ? darkShadows : lightShadows,
    wallpaper: WALLPAPERS[wallpaperName][scheme],
    wallpaperName,
    space,
    radii,
    type,
    motion,
    hairline: HAIRLINE[scheme],
    hairlineSoft: HAIRLINE_SOFT[scheme],
    edge: EDGE[scheme],
    edgeSoft: EDGE_SOFT[scheme],
    tintSunk: TINT_SUNK[scheme],
    reduceTransparency,
    reduceMotion,
    accent: name => resolveAccent(name ?? 'default', scheme)
  }
}

const ThemeContext = createContext<Theme>(buildTheme('light', 'blue', false, false))

/**
 * Both accessibility flags, as one subscription each.
 *
 * They are read here rather than per surface: a list of forty rows must not open
 * forty native subscriptions, and both settings change so rarely that a context
 * re-render is the cheapest possible delivery.
 */
function useAccessibilityPreferences(): { reduceTransparency: boolean; reduceMotion: boolean } {
  const [reduceTransparency, setReduceTransparency] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let alive = true

    // Both getters reject on a platform that does not implement them, and a
    // missing accessibility setting is not a reason to fail to render.
    AccessibilityInfo.isReduceTransparencyEnabled?.()
      .then(value => {
        if (alive) {
          setReduceTransparency(Boolean(value))
        }
      })
      .catch(() => {})

    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(value => {
        if (alive) {
          setReduceMotion(Boolean(value))
        }
      })
      .catch(() => {})

    const transparency = AccessibilityInfo.addEventListener('reduceTransparencyChanged', value =>
      setReduceTransparency(Boolean(value))
    )
    const reduced = AccessibilityInfo.addEventListener('reduceMotionChanged', value => setReduceMotion(Boolean(value)))

    return () => {
      alive = false
      transparency?.remove()
      reduced?.remove()
    }
  }, [])

  return { reduceTransparency, reduceMotion }
}

export interface ThemeProviderProps {
  children: ReactNode
  /**
   * Pin the scheme, whatever the system and the stored preference say.
   *
   * Development only (`--hermieTheme dark`). A simulator's appearance is
   * Simulator.app state and this machine has none, so without this the dark
   * theme could not be photographed at all — see docs/platform-notes.md.
   */
  forceScheme?: Scheme
  /** Pin the wallpaper, for the same reason (`--hermieWallpaper warm`). */
  forceWallpaper?: WallpaperName
}

export function ThemeProvider({ children, forceScheme, forceWallpaper }: ThemeProviderProps) {
  // `useColorScheme` follows the system appearance on every platform, a Mac
  // window included. The stored appearance overrides it when the user pinned
  // one, which is why the preference is read here rather than in Settings: the
  // theme is what every screen resolves through.
  const system = useColorScheme() === 'dark' ? 'dark' : 'light'
  const appearance = useSettingsStore(state => state.appearance)
  const wallpaper = useSettingsStore(state => state.wallpaper)
  const loaded = useSettingsStore(state => state.loaded)
  const { reduceTransparency, reduceMotion } = useAccessibilityPreferences()

  useEffect(() => {
    // Hydrating here rather than further down the tree keeps the very first
    // paint from flashing the system scheme before the stored one arrives.
    if (!loaded) {
      void useSettingsStore.getState().hydrate()
    }
  }, [loaded])

  const scheme = forceScheme ?? (appearance === 'system' ? system : appearance)
  const wallpaperName = forceWallpaper ?? wallpaper
  const theme = useMemo(
    () => buildTheme(scheme, wallpaperName, reduceTransparency, reduceMotion),
    [scheme, wallpaperName, reduceTransparency, reduceMotion]
  )

  // The status bar follows the PINNED appearance, not the system's, and it is
  // rendered here because this is the one component that knows which of the two
  // won and the one that sits above every screen, so the setting survives
  // navigation. Android needs it said out loud: the window starts with
  // `windowLightStatusBar` unset — white icons — and edge-to-edge makes the bar
  // transparent, so on a light wallpaper the clock, the battery and the signal
  // bars simply disappear. `style` is the INK, not the background, so a dark app
  // needs light icons. On a Mac there is no status bar to paint and the call is
  // inert.
  return (
    <ThemeContext.Provider value={theme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
