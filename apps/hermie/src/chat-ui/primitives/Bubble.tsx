/**
 * A speech bubble, and the only thing in the kit allowed to be one.
 *
 * Geometry from `design/liquid-glass-tokens.md` §4 and §6.1: radius 22 with a
 * 6pt sender-side bottom corner, a width cap that is a percentage plus a point
 * cap, and a tail that is ONE path belonging to the bubble.
 *
 * Four things here are load-bearing and should not be "tidied":
 *
 *  - **The tail is an SVG path.** The previous build built it from positioned
 *    `View`s: a small square with one rounded corner, offset `-5`, tucked under
 *    the bubble's edge. On the owner's Mac build that showed as a ~10pt square of
 *    bubble colour protruding past the bottom-right corner with a notch in it,
 *    plus a dark vertical sliver where the square's box was wider than the
 *    bubble's own. A rectangle has square corners and a sibling view has an
 *    anti-aliased edge; neither problem exists for a path with the tail's actual
 *    silhouette.
 *  - **The tail is drawn BEHIND the bubble, not inside it.** Only the part that
 *    escapes the bubble's rounded corner is visible, so the join can never show
 *    as a seam or a band — even though the tail is a flat colour and the bubble
 *    is a gradient. Drawing it on top would paint a 5pt strip of the bottom stop
 *    over a lighter part of the gradient, which reads as a stripe on a tall
 *    bubble.
 *  - **Every offset is a whole point.** The Mac renders the iPad build scaled,
 *    so a sub-point offset that is invisible at 3x is a visible sliver there. The
 *    tail's own width is the wrapper's padding, which keeps it inside the column
 *    instead of hanging over the list's gutter.
 *  - **An incoming bubble is not a `GlassSurface`.** §7.4: no blur view per row —
 *    a virtualised list with one per bubble is the fastest way to make a long
 *    report scroll badly, and on Android there are none at all. The glass recipe
 *    is composited by hand, and a long reply swaps it for the near-opaque reading
 *    wash so its contrast stops being a function of the wallpaper.
 */
import { LinearGradient } from 'expo-linear-gradient'
import type { ReactNode } from 'react'
import { useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { useTheme } from '../../ui/theme'
import {
  BUBBLE_MAX,
  REGULAR_LAYOUT_MIN_WIDTH,
  TAIL,
  TAIL_OVERLAP,
  type BubbleVariant,
  type ResolvedBubbleWidth
} from '../../ui/tokens'

export interface BubbleProps {
  side: 'own' | 'other'
  /**
   * Which recipe paints the interior.
   *
   * `own` ignores it — an outgoing bubble is the chat's accent gradient — so the
   * variant only ever describes an incoming one.
   */
  variant?: BubbleVariant
  /**
   * The outgoing gradient, top → bottom, from `useChatAccent`.
   *
   * Passed in rather than read here: the bubble does not know which chat it is
   * in, and the accent is one lookup per screen rather than one per row.
   */
  accent?: { top: string; bottom: string }
  /** Draws the tail. Only the LAST bubble of a group gets one. */
  tail?: boolean
  /** Continues a run: the top corner on the sender's side tucks in too. */
  grouped?: boolean
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

/** How far the tail sticks out past the bubble. A whole number, deliberately. */
const TAIL_REACH = TAIL.width - TAIL_OVERLAP

/**
 * The cap a bubble may grow to.
 *
 * Both halves matter: the percentage keeps a short line off the far gutter, and
 * the point cap is what stops a long report from spanning a Mac window. React
 * Native takes one `maxWidth`, so the percentage goes on the bubble and the point
 * cap on the wrapper around it.
 */
export function useBubbleWidth(): ResolvedBubbleWidth {
  const { width } = useWindowDimensions()

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? BUBBLE_MAX.regular : BUBBLE_MAX.compact
}

/**
 * The tail, filled flat.
 *
 * Flat is correct rather than convenient: it sits at the bubble's lower edge,
 * where a vertical gradient has already arrived at its bottom stop, so one colour
 * matches exactly. The viewBox is a point taller than the shape's nominal height
 * because the path's lowest control point reaches 17.7 and a 17-high box would
 * clip the curve's last half point — which at Mac scaling is a flat edge where a
 * curve should be.
 */
function Tail({ side, color }: { side: 'own' | 'other'; color: string }) {
  const own = side === 'own'

  return (
    <View
      // Decorative: the shape is the bubble's silhouette, not an object of its
      // own, so it is hidden from assistive technology entirely.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        bottom: 0,
        height: TAIL.height + 1,
        position: 'absolute',
        width: TAIL.width,
        ...(own ? { right: 0 } : { left: 0 }),
        // Mirroring is the whole difference between the two sides; there is no
        // second path and no second set of numbers to keep in step.
        ...(own ? {} : { transform: [{ scaleX: -1 }] })
      }}
    >
      <Svg height={TAIL.height + 1} viewBox={`0 0 ${TAIL.width} ${TAIL.height + 1}`} width={TAIL.width}>
        <Path d={TAIL.path} fill={color} />
      </Svg>
    </View>
  )
}

export function Bubble({
  side,
  variant = 'in',
  accent,
  tail = true,
  grouped = false,
  children,
  style,
  testID
}: BubbleProps) {
  const theme = useTheme()
  const max = useBubbleWidth()
  const own = side === 'own'
  const recipe = theme.bubbles[variant]
  const gradient = own ? accent : undefined
  const reading = variant === 'inRead' || variant === 'dmRead'

  // The sender-side bottom corner tucks in so the tail can meet it — but only on
  // the bubble that HAS a tail. A bubble in the middle of a run keeps its full
  // radius there, which is what makes the run read as one block.
  const tuck = tail ? theme.radii.tail : theme.radii.bubble
  const corners = {
    borderBottomLeftRadius: own ? theme.radii.bubble : tuck,
    borderBottomRightRadius: own ? tuck : theme.radii.bubble,
    borderTopLeftRadius: grouped && !own ? theme.radii.tail : theme.radii.bubble,
    borderTopRightRadius: grouped && own ? theme.radii.tail : theme.radii.bubble
  }

  const tailColor = own ? (gradient?.bottom ?? theme.accent().bubble.bottom) : recipe.tail

  return (
    <View
      style={{
        alignItems: own ? 'flex-end' : 'flex-start',
        maxWidth: max.points + TAIL_REACH,
        // The tail lives in this padding rather than hanging over the list's
        // gutter, so the bubble and its tail are one box as far as layout is
        // concerned.
        ...(own ? { paddingRight: TAIL_REACH } : { paddingLeft: TAIL_REACH })
      }}
    >
      {tail ? <Tail color={tailColor} side={side} /> : null}

      <View style={[corners, { maxWidth: `${max.percent}%`, overflow: 'hidden' }, style]} testID={testID}>
        <LinearGradient
          colors={gradient ? [gradient.top, gradient.bottom] : recipe.gradient}
          end={{ x: 0, y: 1 }}
          pointerEvents="none"
          start={{ x: 0, y: 0 }}
          style={{
            bottom: 0,
            left: 0,
            position: 'absolute',
            right: 0,
            top: 0,
            // The rung under a translucent recipe. `own` never needs one: its
            // gradient has no alpha.
            ...(own ? {} : { backgroundColor: recipe.solid })
          }}
        />

        <View
          style={{
            paddingHorizontal: reading ? theme.space.lg : theme.space.md + 2,
            paddingVertical: theme.space.sm + 2
          }}
        >
          {children}
        </View>
      </View>
    </View>
  )
}
