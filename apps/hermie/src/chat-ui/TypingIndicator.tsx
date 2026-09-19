/**
 * Three dots in a received bubble, for the gap between "the turn started" and
 * "the first token arrived".
 *
 * The animation respects the platform's reduce-motion setting: without it the
 * dots hold still, which is the whole point of the setting.
 */
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, View } from 'react-native'

import { useTheme } from '../ui/theme'

export interface TypingIndicatorProps {
  testID?: string
}

const DOTS = [0, 1, 2]

export function TypingIndicator({ testID = 'typing-indicator' }: TypingIndicatorProps) {
  const theme = useTheme()
  const [reduceMotion, setReduceMotion] = useState(false)
  const values = useRef(DOTS.map(() => new Animated.Value(0.35))).current

  useEffect(() => {
    let cancelled = false

    void AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => {
        if (!cancelled) {
          setReduceMotion(enabled)
        }
      })
      .catch(() => undefined)

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)

    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (reduceMotion) {
      values.forEach(value => value.setValue(0.6))

      return
    }

    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(value, { duration: 340, toValue: 1, useNativeDriver: false }),
          Animated.timing(value, { duration: 340, toValue: 0.35, useNativeDriver: false }),
          Animated.delay((DOTS.length - index - 1) * 140)
        ])
      )
    )

    loops.forEach(loop => loop.start())

    return () => loops.forEach(loop => loop.stop())
  }, [reduceMotion, values])

  return (
    <View
      accessibilityLabel="Replying"
      accessibilityRole="progressbar"
      style={{
        alignItems: 'center',
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceRaised,
        borderBottomLeftRadius: 5,
        borderBottomRightRadius: theme.radii.bubble,
        borderTopLeftRadius: theme.radii.bubble,
        borderTopRightRadius: theme.radii.bubble,
        flexDirection: 'row',
        gap: 5,
        marginVertical: theme.space.sm,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.md
      }}
      testID={testID}
    >
      {values.map((value, index) => (
        <Animated.View
          key={index}
          style={{
            backgroundColor: theme.colors.textMuted,
            borderRadius: 4,
            height: 8,
            opacity: value,
            width: 8
          }}
        />
      ))}
    </View>
  )
}
