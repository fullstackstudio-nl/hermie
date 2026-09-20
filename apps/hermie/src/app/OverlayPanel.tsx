/**
 * Activity, Crons and Settings on the wide layout: a glass panel that slides in
 * over the CHAT COLUMN from the right, behind a dimmed scrim, while the sidebar
 * stays put and stays usable.
 *
 * That last part is the whole point of the shape. These destinations are things
 * you consult, not places you go, and replacing the chat with them costs the
 * reader their place; covering half the window and leaving the list alone does
 * not. The sidebar is outside the scrim on purpose — a different chat is one tap
 * away while Settings is open.
 *
 * ### Escape goes back one level
 *
 * The panel registers on the Escape stack in `src/ui/useEscapeKey.ts`, which
 * delivers to whatever registered LAST. A sub page inside the panel — a cron's
 * detail, a run transcript, the connection test — registers its own handler when
 * it opens, which is after this one, so the first Escape pops the sub page and
 * the panel stays; a second Escape closes the panel. Nothing here coordinates
 * that: it falls out of mount order, which is exactly why the stack is a stack.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native'

import { strings } from '../i18n/strings'
import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { OVERLAY_MAX_WIDTH, SCRIM_COLOR, TAP_SLOP, WINDOW_GAP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useHardwareBack } from '../ui/useHardwareBack'

export type OverlayPanelProps = {
  visible: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

export function OverlayPanel({ children, onClose, title, visible }: OverlayPanelProps) {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  // Kept mounted for the slide-out, then dropped: a panel that unmounts on the
  // first frame of its own exit animation just disappears.
  const [present, setPresent] = useState(visible)

  useEscapeKey(onClose, visible)
  // Android's back button is the same question as Escape, and this panel is the
  // one surface that never heard either: a sheet is a `Modal`, which consumes
  // the press and answers `onRequestClose`, but this is a plain view, so the
  // press reached the activity and backgrounded the app with the panel still
  // open. Measured on an emulator — back on Settings left for the launcher.
  useHardwareBack(onClose, visible)

  useEffect(() => {
    if (visible) {
      setPresent(true)
    }

    const animation = Animated.timing(progress, {
      duration: theme.reduceMotion ? 0 : theme.motion.sheet,
      easing: Easing.bezier(0.22, 0.61, 0.36, 1),
      toValue: visible ? 1 : 0,
      // `translateX` and `opacity` are both native-driver eligible, and this is
      // the largest thing that moves in the app.
      useNativeDriver: true
    })

    animation.start(({ finished }) => {
      if (finished && !visible) {
        setPresent(false)
      }
    })

    return () => animation.stop()
  }, [progress, theme.motion.sheet, theme.reduceMotion, visible])

  if (!present) {
    return null
  }

  return (
    <>
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM_COLOR, opacity: progress }]}
      >
        <Pressable
          accessibilityLabel={strings.layout.close}
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="overlay-scrim"
        />
      </Animated.View>

      <Animated.View
        style={{
          bottom: WINDOW_GAP,
          position: 'absolute',
          right: WINDOW_GAP,
          top: WINDOW_GAP,
          transform: [
            {
              // Off to the right by its own width plus the gap, so no part of it
              // is left peeking at the window edge.
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [OVERLAY_MAX_WIDTH + WINDOW_GAP, 0]
              })
            }
          ],
          // Its own width, but never wider than the column it covers — on a
          // window only just past the wide threshold that column is narrow.
          maxWidth: '100%',
          width: OVERLAY_MAX_WIDTH
        }}
        testID="overlay-panel"
      >
        <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
          <View
            style={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.md,
              paddingHorizontal: theme.space.panel,
              paddingTop: theme.space.panel
            }}
          >
            <Text style={{ flex: 1 }} variant="title">
              {title}
            </Text>

            <Pressable
              accessibilityLabel={strings.layout.close}
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onClose}
              testID="overlay-close"
            >
              <GlassSurface
                contentStyle={{ alignItems: 'center', height: 38, justifyContent: 'center', width: 38 }}
                variant="control"
              >
                <Text color="textMuted" style={{ fontSize: 17 }}>
                  {'✕'}
                </Text>
              </GlassSurface>
            </Pressable>
          </View>

          <View style={{ flex: 1 }}>{children}</View>
        </GlassSurface>
      </Animated.View>
    </>
  )
}
