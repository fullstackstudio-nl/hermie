/**
 * The app's bottom sheet: `Modal` + `Animated`, and nothing else.
 *
 * macOS has no `react-native-screens` and no gesture library (see
 * `docs/platform-notes.md`), so a sheet built on a gesture handler would exist
 * on two of the four targets. This one slides with `Animated` on the JS driver
 * — `useNativeDriver` is unavailable for layout properties on the old
 * architecture — and dismisses on an explicit tap, never on a drag.
 *
 * That last part is a decision, not a limitation: ADR-0010 says an agent's
 * question is answered by an explicit tap, because a swipe that lands on
 * "Allow" is not consent.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ViewStyle
} from 'react-native'

import { useSafeAreaInsets } from '../platform/safe-area'
import { Text } from './primitives'
import { useTheme } from './theme'

export interface BottomSheetProps {
  visible: boolean
  /** Called for a backdrop tap or a hardware back press. Ignored when blocking. */
  onRequestClose: () => void
  /**
   * A question that must be answered on the sheet: the backdrop stops
   * dismissing and the grabber is hidden, so the only ways out are the sheet's
   * own buttons.
   */
  blocking?: boolean
  children: ReactNode
  /** Sheet content scrolls by default; a sheet that manages its own scrolling opts out. */
  scrollable?: boolean
  accessibilityLabel?: string
  testID?: string
  contentStyle?: ViewStyle
}

const ANIMATION_MS = 220

export function BottomSheet({
  visible,
  onRequestClose,
  blocking = false,
  children,
  scrollable = true,
  accessibilityLabel,
  testID,
  contentStyle
}: BottomSheetProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  // The modal stays mounted for the slide-out, so `visible` alone cannot drive
  // it; `mounted` trails it by one animation.
  const [mounted, setMounted] = useState(visible)
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current

  useEffect(() => {
    if (visible) {
      setMounted(true)
    }

    const animation = Animated.timing(progress, {
      duration: ANIMATION_MS,
      toValue: visible ? 1 : 0,
      // Layout properties are not native-driver eligible on the old
      // architecture, which is what macOS runs.
      useNativeDriver: false
    })

    animation.start(({ finished }) => {
      if (finished && !visible) {
        setMounted(false)
      }
    })

    return () => animation.stop()
  }, [progress, visible])

  if (!mounted) {
    return null
  }

  const maxHeight = Math.round(Dimensions.get('window').height * 0.86)

  const body = (
    <View style={{ gap: theme.space.md, paddingBottom: insets.bottom + theme.space.lg }}>
      {blocking ? null : (
        <View
          accessibilityLabel="Drag handle"
          style={{
            alignSelf: 'center',
            backgroundColor: theme.colors.border,
            borderRadius: 3,
            height: 5,
            marginBottom: theme.space.xs,
            width: 40
          }}
        />
      )}
      {children}
    </View>
  )

  return (
    <Modal animationType="none" onRequestClose={blocking ? undefined : onRequestClose} transparent visible={mounted}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }} testID={testID}>
        <Animated.View style={{ flex: 1, opacity: progress }}>
          <Pressable
            accessibilityLabel={blocking ? undefined : 'Dismiss'}
            accessibilityRole={blocking ? undefined : 'button'}
            // A blocking sheet still paints a backdrop; it just does not answer
            // to it.
            disabled={blocking}
            onPress={onRequestClose}
            style={{ backgroundColor: '#00000066', flex: 1 }}
            testID={testID ? `${testID}-backdrop` : 'sheet-backdrop'}
          />
        </Animated.View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityViewIsModal
            style={[
              {
                backgroundColor: theme.colors.bg,
                borderTopLeftRadius: theme.radii.sheet,
                borderTopRightRadius: theme.radii.sheet,
                maxHeight,
                paddingHorizontal: theme.space.xl,
                paddingTop: theme.space.md,
                transform: [
                  {
                    translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [maxHeight, 0] })
                  }
                ]
              },
              contentStyle
            ]}
          >
            {scrollable ? (
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {body}
              </ScrollView>
            ) : (
              body
            )}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

/** The small capitalised line the design board puts above a sheet's title. */
export function SheetEyebrow({ children }: { children: string }) {
  return (
    <Text color="textMuted" style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.1 }}>
      {children}
    </Text>
  )
}
