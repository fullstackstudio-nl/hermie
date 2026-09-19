/**
 * The reading fold: a long body clipped with a gradient mask and a
 * `Show more` / `Show less` control.
 *
 * Two rules the mockup states and one the streaming path forces:
 *
 *  - Past roughly fourteen lines the body folds (§6.3). Fourteen lines is
 *    expressed as a height because that is what `maxHeight` takes, and the phone
 *    folds sooner because its bubble is narrower.
 *  - The state belongs to the LIST, not to this component — see `expanded.tsx`.
 *    A fold that lived here would re-collapse every time the row was virtualised
 *    out and back.
 *  - **Never fold the message that is currently streaming.** A fold appearing
 *    mid-stream clips the words being written, and a `Show more` that the reader
 *    taps and that then grows past the fold on its own is worse than no fold. The
 *    turn finishes first.
 *
 * The mask is a gradient from transparent to the surface colour, so the last
 * visible line fades instead of being guillotined mid-x-height. It needs the
 * colour it is fading INTO, which only the caller knows.
 */
import { LinearGradient } from 'expo-linear-gradient'
import { useState, type ReactNode } from 'react'
import { Pressable, useWindowDimensions, View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { FOLD_HEIGHT, REGULAR_LAYOUT_MIN_WIDTH, TAP_SLOP, withAlpha } from '../../ui/tokens'
import { chatStrings } from '../strings'

export interface FoldProps {
  expanded: boolean
  onToggle: () => void
  /** A streaming body is never folded, whatever its height. */
  streaming?: boolean
  /** What the mask fades into: the bubble's own lower colour. */
  fadeTo: string
  /**
   * How far the mask reaches PAST the text, in points.
   *
   * The fold lives inside the bubble's padded content box, so a mask that spans
   * only that box paints a rectangle with the bubble's padding visible around it
   * — an obvious seam rather than a fade. The clip box is pulled out by `bleed`
   * and padded back in by the same amount, so the mask covers the bubble's full
   * width while the text keeps its inset.
   */
  bleed?: number
  children: ReactNode
  testID?: string
}

export function useFoldHeight(): number {
  const { width } = useWindowDimensions()

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? FOLD_HEIGHT.regular : FOLD_HEIGHT.compact
}

export function Fold({ expanded, onToggle, streaming = false, fadeTo, bleed = 0, children, testID }: FoldProps) {
  const theme = useTheme()
  const limit = useFoldHeight()
  const [natural, setNatural] = useState(0)

  // `natural` is measured on the INNER view, which is never height-constrained,
  // so it keeps reporting the real height even while the outer box clips it.
  const overflows = !streaming && natural > limit + theme.space.lg
  const clipped = overflows && !expanded

  return (
    <View testID={testID}>
      <View
        style={{
          marginHorizontal: -bleed,
          maxHeight: clipped ? limit : undefined,
          overflow: 'hidden',
          paddingHorizontal: bleed
        }}
      >
        <View onLayout={event => setNatural(event.nativeEvent.layout.height)}>{children}</View>

        {clipped ? (
          /*
            The first stop is the fade colour at ZERO ALPHA, not the keyword
            `transparent`.

            `transparent` is rgba(0,0,0,0) — transparent BLACK — so interpolating
            from it to an opaque colour travels through dark grey and paints a
            dirty band across the last two lines. On the dark theme that band was
            plainly visible over the bubble, with the clipped line ghosting
            through it. Fading a colour to itself is the only way to make the mask
            disappear into the surface.
          */
          <LinearGradient
            colors={[withAlpha(fadeTo, 0), withAlpha(fadeTo, 0.85), fadeTo]}
            locations={[0, 0.65, 1]}
            pointerEvents="none"
            style={{ bottom: 0, height: 64, left: 0, position: 'absolute', right: 0 }}
          />
        ) : null}
      </View>

      {overflows ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={TAP_SLOP}
          onPress={onToggle}
          style={{ justifyContent: 'center', marginTop: theme.space.xs, minHeight: 20 }}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Text color="accentText" variant="meta">
            {expanded ? chatStrings.fold.less : chatStrings.fold.more}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
