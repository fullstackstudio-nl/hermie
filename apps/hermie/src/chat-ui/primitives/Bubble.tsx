/**
 * The bubble geometry from `design/tokens.md`: 20px radius with a 5px corner
 * on the sender's side, and a tail on the outgoing one.
 *
 * The tail is a small square with one rounded corner tucked under the bubble's
 * bottom edge — the same trick the design board uses, and the only one that
 * works without an SVG dependency or a shadow that would show on the wrong
 * background.
 */
import type { ReactNode } from 'react'
import { View, type ViewStyle } from 'react-native'

import { useTheme } from '../../ui/theme'

export interface BubbleProps {
  side: 'own' | 'other'
  background: string
  /** Draws the tail. Only the last bubble of a run needs one. */
  tail?: boolean
  children: ReactNode
  style?: ViewStyle
  maxWidthPercent?: number
}

export function Bubble({ side, background, tail = true, children, style, maxWidthPercent = 88 }: BubbleProps) {
  const theme = useTheme()
  const own = side === 'own'

  return (
    <View
      style={[
        {
          alignSelf: own ? 'flex-end' : 'flex-start',
          backgroundColor: background,
          borderBottomLeftRadius: own ? theme.radii.bubble : 5,
          borderBottomRightRadius: own ? 5 : theme.radii.bubble,
          borderTopLeftRadius: theme.radii.bubble,
          borderTopRightRadius: theme.radii.bubble,
          maxWidth: `${maxWidthPercent}%`,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md
        },
        style
      ]}
    >
      {children}
      {tail ? (
        <View
          // Decorative: the shape is the bubble's, not its own object.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{
            backgroundColor: background,
            borderBottomLeftRadius: own ? 12 : 0,
            borderBottomRightRadius: own ? 0 : 12,
            bottom: 0,
            height: 16,
            position: 'absolute',
            width: 12,
            ...(own ? { right: -5 } : { left: -5 })
          }}
        />
      ) : null}
    </View>
  )
}
