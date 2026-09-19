/**
 * Everything a bottom sheet is, apart from the box it is presented in.
 *
 * There are two boxes. iOS and Android get a `Modal`, which is what puts the
 * sheet above the navigator and dims the rest of the app for free.
 * react-native-macos has no `RCTModalHostView` at all — the class in
 * `React/Views/RCTModalHostView.m` is wrapped in `#if !TARGET_OS_OSX` — so a
 * `Modal` there is an unknown view manager and every sheet red-boxes. The macOS
 * variant therefore paints the same thing into an absolutely positioned overlay
 * instead.
 *
 * The props, the animation, the backdrop and the panel live here so the two
 * variants cannot drift. This module deliberately has NO `.macos` sibling:
 * inside a `.macos` file a relative specifier resolves back to that same file
 * (see "Platform-variant modules resolve to themselves" in
 * `docs/platform-notes.md`), and a module with no variant cannot be captured
 * that way.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Dimensions, KeyboardAvoidingView, Pressable, ScrollView, View, type ViewStyle } from 'react-native'

import { useSafeAreaInsets } from '../../platform/safe-area'
import { KEYBOARD_AVOID_BEHAVIOR } from '../keyboard'
import { Text } from '../primitives'
import { useTheme } from '../theme'

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
 * before it stops existing. Both variants need exactly this, and neither may
 * own it alone.
 */
export function useSheetPresence(
  visible: boolean,
  onClosed?: () => void
): { mounted: boolean; progress: Animated.Value } {
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
      // Layout properties are not native-driver eligible on the old
      // architecture, which is what macOS runs.
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
export function sheetMaxHeight(): number {
  return Math.round(Dimensions.get('window').height * 0.86)
}

export interface SheetBodyProps extends Omit<BottomSheetProps, 'visible'> {
  progress: Animated.Value
  maxHeight: number
}

/**
 * The backdrop and the panel — everything inside the presenting box.
 *
 * `flex: 1` and `justifyContent: 'flex-end'` are what park the panel at the
 * bottom of whatever the caller put this in: a modal's root on iOS and Android,
 * an absolutely positioned overlay on macOS.
 */
export function SheetBody({
  onRequestClose,
  blocking = false,
  children,
  scrollable = true,
  accessibilityLabel,
  testID,
  contentStyle,
  progress,
  maxHeight
}: SheetBodyProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

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
