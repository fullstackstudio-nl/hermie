/**
 * One glass surface, in whichever material this platform can draw.
 *
 * A glass surface is a stack: a blur, one or two translucent gradients, a
 * specular edge and a drop shadow. Which parts are real depends on the platform
 * (`material.ts`) and on the reader's Reduce Transparency setting; the token set
 * is identical in all three cases, which is the point — the dark elevation
 * ladder is defined so that the solid fallback keeps the same hierarchy.
 *
 * Two rules from `design/liquid-glass-tokens.md` are enforced here rather than
 * documented and hoped for:
 *
 *  - **Never nest glass more than one level.** Panel (level 1) → header,
 *    composer, sheet, card (level 2) → tint only (level 3). Two stacked blurs
 *    cost real frame time on the wide layout and visually cancel out: the second
 *    samples an already-blurred backdrop and returns mud. A `GlassSurface`
 *    inside a `GlassSurface` inside a `GlassSurface` therefore drops to a tint
 *    on its own, by reading the depth off a context.
 *  - **Text-heavy surfaces get a tint layer.** `opaque` lays the surface's solid
 *    rung under the gradient at full strength, so body-text contrast is a fixed
 *    number rather than a function of whatever is behind it.
 */
import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { createContext, useContext, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { useTheme } from '../theme'
import type { GlassVariant, ShadowName } from '../tokens'
import { GLASS_MATERIAL } from './material'
import { GlassContainer, GlassView } from './native-effect'

/** How many glass surfaces are already between this one and the wallpaper. */
const GlassDepth = createContext(0)

/**
 * How many glass surfaces are between the caller and the wallpaper.
 *
 * Read by anything that would otherwise paint an opaque background of its own.
 * `Screen` is the one that matters: it fills with the app's background colour
 * and adds the safe-area inset, both of which are right on a phone and both of
 * which are wrong inside a floating panel that has already done them.
 */
export function useGlassDepth(): number {
  return useContext(GlassDepth)
}

/** The level past which a surface stops blurring and becomes a plain tint. */
const MAX_GLASS_DEPTH = 2

export type GlassSurfaceProps = Omit<ViewProps, 'style'> & {
  variant?: GlassVariant
  /** Defaults to the radius that belongs to the variant. */
  radius?: number
  shadow?: ShadowName | 'none'
  /** A chat's accent, laid under the gradient. Used by the selected row. */
  tint?: string
  /** Lay the solid rung under the glass, for a surface that carries body text. */
  opaque?: boolean
  style?: StyleProp<ViewStyle>
  /** The outer box carries the shadow; this styles the clipped inner surface. */
  contentStyle?: StyleProp<ViewStyle>
  children?: ReactNode
}

const RADIUS_FOR: Record<GlassVariant, keyof ReturnType<typeof useTheme>['radii']> = {
  panel: 'panel',
  float: 'sheet',
  sheet: 'sheet',
  card: 'card',
  row: 'card',
  rowSelected: 'card',
  control: 'pill',
  chip: 'pill'
}

const SHADOW_FOR: Record<GlassVariant, ShadowName | 'none'> = {
  panel: 'panel',
  float: 'float',
  sheet: 'sheet',
  card: 'card',
  row: 'none',
  rowSelected: 'card',
  control: 'card',
  chip: 'none'
}

export function GlassSurface({
  variant = 'panel',
  radius,
  shadow,
  tint,
  opaque = false,
  style,
  contentStyle,
  children,
  ...rest
}: GlassSurfaceProps) {
  const theme = useTheme()
  const depth = useContext(GlassDepth)
  const recipe = theme.glass[variant]

  const cornerRadius = radius ?? theme.radii[RADIUS_FOR[variant]]
  const shadowToken = shadow ?? SHADOW_FOR[variant]
  const shadowStyle = shadowToken === 'none' ? null : theme.shadows[shadowToken]

  // A variant whose recipe carries no blur is already a level-3 tint by
  // definition (a chip, a list row), so it never counts towards the depth and
  // never opens a blur view of its own.
  const wantsBlur = recipe.blurIntensity > 0
  const blurred = wantsBlur && !theme.reduceTransparency && depth < MAX_GLASS_DEPTH && GLASS_MATERIAL !== 'solid'
  const childDepth = wantsBlur ? depth + 1 : depth

  /**
   * A level-3 tint stays TRANSLUCENT even where there is no blur anywhere.
   *
   * Its rung exists so that the tint composites onto a known colour, not so
   * that the tint becomes that colour: a chip that paints itself `e4` on a
   * panel is an opaque white rectangle, which is what the gateway card looked
   * like before this distinction existed. The opaque rung belongs to the
   * surfaces that have to hide a wallpaper — panels, sheets, cards — and only
   * when they cannot blur it.
   */
  const translucent = blurred ? !opaque : !wantsBlur

  /** The real material is drawing this surface, so our own layers step back. */
  const native = blurred && GLASS_MATERIAL === 'native'

  // The specular edge reads as an inner highlight on glass and as a plain
  // hairline where there is none, so the border colour follows the material
  // rather than the token set.
  const border = blurred ? (variant === 'panel' ? theme.edge : theme.edgeSoft) : recipe.hairline

  return (
    <View {...rest} style={[shadowStyle, { borderRadius: cornerRadius }, style]}>
      <View
        style={[
          {
            borderRadius: cornerRadius,
            overflow: 'hidden',
            borderWidth: border === 'transparent' ? 0 : 1,
            borderColor: border,
            backgroundColor: translucent ? 'transparent' : recipe.solid
          },
          contentStyle
        ]}
      >
        {blurred ? <Material intensity={recipe.blurIntensity} tint={recipe.nativeTint} radius={cornerRadius} /> : null}

        {/*
          The gradient is what turns a FLAT blur into glass: a bright top-left
          falling to a dimmer middle. The real material already does that, and
          better — it refracts rather than only blurring — so laying the
          gradient over it as well applies the lightening twice and washes the
          wallpaper out of the panel entirely. Measured on an iPhone 17 Pro
          (iOS 26.5): with both, the Blue wallpaper reads as a flat near-white
          field behind the list. So the gradient belongs to the two fallbacks
          and nowhere else.

          The panel uses the mockup's 155° diagonal; every other surface is
          vertical.
        */}
        {native ? null : (
          <LinearGradient
            colors={gradientStops(recipe.gradient)}
            end={variant === 'panel' ? { x: 0.9, y: 1 } : { x: 0, y: 1 }}
            pointerEvents="none"
            start={variant === 'panel' ? { x: 0.1, y: 0 } : { x: 0, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        )}

        {tint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}

        <GlassDepth.Provider value={childDepth}>{children}</GlassDepth.Provider>
      </View>
    </View>
  )
}

/**
 * The blur itself.
 *
 * On iOS 26 this is the real material — a `UIVisualEffectView` carrying a
 * `UIGlassEffect`, which samples and refracts what is behind it rather than only
 * blurring it.
 *
 * Both materials are told the app's scheme rather than left on `auto`. A native
 * material reads the window's trait collection, and with the theme pinned against
 * the system's the two disagree: pinned Light on a Dark Mac drew murky dark glass
 * under light ink. `ThemeProvider` now overrides the window's interface style, so
 * `colorScheme` here is the same answer said twice — which is the point. It is
 * the only thing standing between a material and the system appearance if a
 * window ever escapes that override, and it costs one prop.
 *
 * `isInteractive` is left off. It makes the material react to touches, which is
 * right for a button and wrong for a panel that holds a scrolling list — and the
 * only round controls in Part 1 are small enough that the effect reads as noise.
 */
function Material({ intensity, tint, radius }: { intensity: number; tint?: string | undefined; radius: number }) {
  const theme = useTheme()

  if (GLASS_MATERIAL === 'native') {
    return (
      <GlassView
        colorScheme={theme.scheme}
        glassEffectStyle="regular"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
        {...(tint ? { tintColor: tint } : {})}
      />
    )
  }

  return (
    <BlurView
      intensity={intensity}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      tint={theme.scheme === 'dark' ? 'systemMaterialDark' : 'systemMaterialLight'}
    />
  )
}

/** `LinearGradient` wants at least two stops and types them as a tuple. */
function gradientStops(stops: readonly string[]): readonly [string, string, ...string[]] {
  return (stops.length >= 2 ? stops : [stops[0] ?? 'transparent', stops[0] ?? 'transparent']) as readonly [
    string,
    string,
    ...string[]
  ]
}

/**
 * Several glass surfaces that should merge where they meet.
 *
 * iOS 26 does this natively through `UIGlassContainerEffect`: two round controls
 * closer together than `spacing` flow into one shape the way the system's own
 * toolbars do. Everywhere else it is a plain row, which is what those controls
 * look like anyway.
 */
export function GlassGroup({ spacing = 12, style, children, ...rest }: ViewProps & { spacing?: number }) {
  const theme = useTheme()

  if (GLASS_MATERIAL !== 'native' || theme.reduceTransparency) {
    return (
      <View {...rest} style={style}>
        {children}
      </View>
    )
  }

  return (
    <GlassContainer {...rest} spacing={spacing} style={style}>
      {children}
    </GlassContainer>
  )
}
