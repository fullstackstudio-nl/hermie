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
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'

import { directTouchPanRef } from '../platform/pointer-drag'
import { useSafeAreaInsets } from '../platform/safe-area'
import { GlassSurface } from './glass'
import { KEYBOARD_AVOID_BEHAVIOR } from './keyboard'
import { Text } from './primitives'
import { useTheme } from './theme'
import { Icon, ICON_SIZE } from './Icon'
import { REGULAR_LAYOUT_MIN_WIDTH, SCRIM_COLOR, SHEET_MAX_WIDTH, SIDEBAR_WIDTH, TAP_SLOP, WINDOW_GAP } from './tokens'
import { useEscapeKey } from './useEscapeKey'

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

function noop(): void {
  // A blocking sheet takes Escape and does nothing with it. See `useEscapeKey`.
}

/**
 * `mounted` trails `visible` by one animation, so the sheet can slide out
 * before it stops existing.
 *
 * ## The opening animation, and the one character that had eaten it
 *
 * The value used to start at `visible ? 1 : 0`, and every sheet in this app is
 * mounted AT THE MOMENT it becomes visible — `ChatSheetHost` renders one only
 * when there is one to show. So the first render already had `visible === true`,
 * the value already stood at 1, and the effect then animated 1 → 1: the sheet
 * was simply THERE, fully up, with no slide and no backdrop fade. Closing
 * animated 1 → 0 and looked correct, which is exactly why this survived — the
 * owner's report is "they appear instantly and only animate when closing".
 *
 * It now always starts at 0 and is animated up, on mount and on every
 * `visible` → true. There is no case that wants the old behaviour: a sheet
 * mounted invisible renders nothing at all, so starting from 0 costs it nothing.
 *
 * `reduceMotion` collapses the duration rather than skipping the animation, so
 * the completion callback — which is what unmounts a closed sheet — still runs
 * on exactly the same path.
 *
 * The driver is left on the JavaScript side. `opacity` and `translateY` would
 * both be native-driver eligible, but the closing half has always run this way
 * and looked right, so the driver is not what was wrong here; changing it would
 * be an unverifiable change riding along with a verifiable one.
 */
function useSheetPresence(
  visible: boolean,
  reduceMotion: boolean,
  onClosed?: () => void
): { mounted: boolean; progress: Animated.Value } {
  const [mounted, setMounted] = useState(visible)
  const progress = useRef(new Animated.Value(0)).current
  const closed = useRef(onClosed)

  closed.current = onClosed

  useEffect(() => {
    if (visible) {
      setMounted(true)
    }

    const animation = Animated.timing(progress, {
      duration: reduceMotion ? 0 : SHEET_ANIMATION_MS,
      toValue: visible ? 1 : 0,
      useNativeDriver: false
    })

    animation.start(({ finished }) => {
      if (finished && !visible) {
        setMounted(false)
        closed.current?.()
      }
    })

    return () => animation.stop()
  }, [progress, reduceMotion, visible])

  return { mounted, progress }
}

/**
 * Where the sheet sits, and how wide it is allowed to get.
 *
 * On a phone it is the window, edge to edge. On the wide layout a sheet that
 * spanned a 1366pt window would put its buttons a hand's width apart and lay a
 * scrim over the chat list the reader is still using, so it is capped and parked
 * over the CONTENT COLUMN — the panel the sheet belongs to — rather than centred
 * on the window. The left inset is the sidebar's own width plus the gaps around
 * it, which is where that column starts.
 */
function sheetBox(width: number, height: number): { maxHeight: number; maxWidth: number; left: number } {
  const maxHeight = Math.round(height * 0.86)

  if (width < REGULAR_LAYOUT_MIN_WIDTH) {
    return { left: 0, maxHeight, maxWidth: width }
  }

  const column = SIDEBAR_WIDTH + WINDOW_GAP * 2

  return { left: column, maxHeight, maxWidth: Math.min(SHEET_MAX_WIDTH, width - column) }
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
  const window = useWindowDimensions()
  const { mounted, progress } = useSheetPresence(visible, theme.reduceMotion, onClosed)

  /**
   * Escape closes the sheet — unless it is blocking, in which case it is
   * SWALLOWED rather than ignored.
   *
   * The difference matters. A blocking sheet is an agent's question, and ADR-0010
   * says those are answered by an explicit tap; letting Escape fall through would
   * hand the key to whatever is underneath, so the composer would stop the very
   * turn that is waiting for the answer. Registering a handler that does nothing
   * is how a modal says "the key stops here".
   */
  useEscapeKey(blocking ? noop : onRequestClose, mounted)

  if (!mounted) {
    return null
  }

  const { left, maxHeight, maxWidth } = sheetBox(window.width, window.height)

  const body = (
    <View
      style={{
        gap: theme.space.md,
        paddingBottom: insets.bottom + theme.space.lg,
        paddingHorizontal: theme.space.xl,
        paddingTop: theme.space.md
      }}
    >
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
            backgroundColor: theme.hairline,
            borderRadius: 3,
            height: 5,
            marginBottom: theme.space.xs,
            width: 40
          }}
          testID="sheet-grabber"
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
            style={{ backgroundColor: SCRIM_COLOR, flex: 1 }}
            testID={testID ? `${testID}-backdrop` : 'sheet-backdrop'}
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={KEYBOARD_AVOID_BEHAVIOR}
          // The column inset lives here rather than on the root so it travels with
          // the sheet when the keyboard pushes it up.
          // `paddingBottom: 0` is explicit rather than assumed: this is a
          // `KeyboardAvoidingView`, whose whole job is to add one, and the card
          // below it has to reach the window's edge when it is not doing that.
          style={{ alignItems: 'center', paddingBottom: 0, paddingLeft: left }}
          testID={testID ? `${testID}-column` : 'sheet-column'}
        >
          <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityViewIsModal
            style={{
              maxHeight,
              maxWidth,
              transform: [
                {
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [maxHeight, 0] })
                }
              ],
              width: '100%'
            }}
            testID={testID ? `${testID}-panel` : 'sheet-panel'}
          >
            {/*
              `opaque`: a sheet carries body text and often a command, so its
              contrast has to be a fixed number rather than a function of the
              wallpaper it happens to be over.

              `radiusBottom={0}`: the sheet sits ON the window's bottom edge, so
              its lower corners are square and there is nothing under it. That
              used to be said by overriding four style keys on two of the
              surface's views, which left the third — the native material — still
              rounded; a material is not clipped by a parent's corner mask the way
              a plain layer is, and the owner's report is a rounded lower edge with
              a strip of window showing beneath it. One number now reaches every
              layer. The safe-area inset is padding INSIDE the card (see `body`),
              never a margin under it.
            */}
            <GlassSurface
              contentStyle={[{ maxHeight }, contentStyle]}
              opaque
              radius={theme.radii.sheet}
              radiusBottom={0}
              variant="sheet"
            >
              {scrollable ? (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  ref={directTouchPanRef}
                  showsVerticalScrollIndicator={false}
                >
                  {body}
                </ScrollView>
              ) : (
                body
              )}
            </GlassSurface>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

/**
 * The small capitalised line the design board puts above a sheet's title.
 *
 * It is the `micro` token — §3's uppercase label — rather than three numbers
 * written out beside it, which is how it had drifted to a heavier weight and
 * nearly twice the tracking the scale asks for.
 */
export function SheetEyebrow({ children }: { children: string }) {
  return (
    <Text color="textFaint" variant="micro">
      {children.toUpperCase()}
    </Text>
  )
}

/**
 * A PAGE inside a sheet: a back control, a title, and a body.
 *
 * Shared rather than written per sheet, because the affordance has to be in the
 * same place with the same glyph wherever a sheet goes one level deeper — that
 * is the visible half of "Escape goes back one level", and a page whose back
 * control moved would make the key feel like a different key. The caller owns
 * the Escape registration itself: the handler has to be installed by whoever
 * sits ABOVE the `BottomSheet` in the tree, so that it registers last and wins
 * the key (see `useEscapeKey`).
 */
export function SheetPage({
  children,
  onBack,
  title,
  backLabel = 'Back',
  testID = 'sheet-page-back'
}: {
  children: ReactNode
  onBack: () => void
  title: string
  backLabel?: string
  testID?: string
}) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.md }}>
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Pressable
          accessibilityLabel={backLabel}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onBack}
          style={{ alignItems: 'center', justifyContent: 'center', minHeight: 32, minWidth: 24 }}
          testID={testID}
        >
          <Icon color={theme.colors.accentText} name="chevronLeft" size={ICON_SIZE.control} />
        </Pressable>
        <Text style={{ flex: 1 }} variant="sheetTitle">
          {title}
        </Text>
      </View>

      {children}
    </View>
  )
}
