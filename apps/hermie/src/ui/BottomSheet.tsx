/**
 * The app's bottom sheet: `Modal` + `Animated`, and nothing else.
 *
 * It slides with `Animated` on the JS driver — `useNativeDriver` is unavailable
 * for layout properties — and dismisses on an explicit tap, never on a drag.
 * That last part is a decision, not a limitation: ADR-0010 says an agent's
 * question is answered by an explicit tap, because a swipe that lands on
 * "Allow" is not consent, so no gesture library is involved anywhere here.
 *
 * This used to be three files. `react-native-macos` had no `RCTModalHostView`,
 * so a `Modal` red-boxed on a Mac and the sheet was split into a shared body
 * plus one presenter per platform. The Mac is the iPad build now (ADR-0011) and
 * has a real `Modal`, so the split is gone.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  View,
  type ViewStyle
} from 'react-native'

import { useSafeAreaInsets } from '../platform/safe-area'
import { KEYBOARD_AVOID_BEHAVIOR } from './keyboard'
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
  /**
   * The slide-out has finished and the sheet is off the screen.
   *
   * `ChatSheetHost` swaps one sheet for another on this, which is the only way
   * to open the next one after the previous one has actually gone rather than
   * on top of it.
   */
  onClosed?: () => void
}

export const SHEET_ANIMATION_MS = 220

/**
 * `mounted` trails `visible` by one animation, so the sheet can slide out
 * before it stops existing.
 */
function useSheetPresence(visible: boolean, onClosed?: () => void): { mounted: boolean; progress: Animated.Value } {
  const [mounted, setMounted] = useState(visible)
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current
  const closed = useRef(onClosed)

  closed.current = onClosed

  useEffect(() => {
    if (visible) {
      setMounted(true)
    }

    const animation = Animated.timing(progress, {
      duration: SHEET_ANIMATION_MS,
      toValue: visible ? 1 : 0,
      // Layout properties are not native-driver eligible.
      useNativeDriver: false
    })

    animation.start(({ finished }) => {
      if (finished && !visible) {
        setMounted(false)
        closed.current?.()
      }
    })

    return () => animation.stop()
  }, [progress, visible])

  return { mounted, progress }
}

/** How tall a sheet may grow: most of the window, never all of it. */
function sheetMaxHeight(): number {
  return Math.round(Dimensions.get('window').height * 0.86)
}

export function BottomSheet({
  visible,
  onClosed,
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
  const { mounted, progress } = useSheetPresence(visible, onClosed)

  if (!mounted) {
    return null
  }

  const maxHeight = sheetMaxHeight()

  const body = (
    <View style={{ gap: theme.space.md, paddingBottom: insets.bottom + theme.space.lg }}>
      {blocking ? null : (
        <View
          // The bar is decoration, not a control: this sheet never listens to a
          // drag (ADR-0010 — a swipe that lands on "Allow" is not consent), so
          // announcing a "Drag handle" would promise a gesture that does not
          // exist. The way out is the backdrop, which IS labelled.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
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
    <Modal
      animationType="none"
      // Android draws the sheet's own backdrop behind the system bars rather
      // than leaving two opaque strips above and below a dimmed screen. The
      // navigation-bar flag is only honoured together with the status-bar one.
      navigationBarTranslucent
      onRequestClose={blocking ? undefined : onRequestClose}
      statusBarTranslucent
      transparent
      visible={mounted}
    >
      {/* `flex: 1` and `justifyContent: 'flex-end'` are what park the panel at
          the bottom of the modal's root. */}
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

        <KeyboardAvoidingView behavior={KEYBOARD_AVOID_BEHAVIOR}>
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
