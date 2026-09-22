/**
 * The grab handle on a reorderable row, as one thing rather than two copies.
 *
 * A chat row and a folder row both grew one, with the same 26pt column, the
 * same glyph and the same accessibility label written out twice — which is two
 * places for a grip to stop looking like the other one. The pointer states are
 * what made that worth collapsing: on a Mac a handle that gives no sign it can
 * be grabbed is a handle nobody grabs, and adding that sign in one file and not
 * the other is exactly the failure a duplicated control produces.
 *
 * ## A `View`, deliberately, and not a `Pressable`
 *
 * A pressable claims the touch before the pan responder behind it sees one, so
 * the row would stop being draggable by its own handle. The handlers are spread
 * straight onto this view instead — they are `PanResponder`'s, and a plain view
 * is all they need.
 *
 * That also means the hover comes from `useHover` rather than from a pressable's
 * own state: `onPointerEnter`/`onPointerLeave` are view props on every platform
 * in React Native 0.81, and they simply never fire where there is no pointer. On
 * a phone this costs one boolean that is false forever.
 *
 * `cursor` has exactly two values in React Native 0.81, `auto` and `pointer`, so
 * a pointing hand is what a grip can say. `grab` is what a Mac would draw for
 * one, and it is not on offer here; `pointer` is the honest half of it, and it
 * is the same value every other control in the app uses.
 */
import { View } from 'react-native'
import type { PanResponderInstance } from 'react-native'

import { Icon, ICON_SIZE } from './Icon'
import { useTheme } from './theme'
import { useHover } from './useHover'

/** The column a grip occupies, so two lists of rows line their grips up. */
export const DRAG_GRIP_WIDTH = 26

export interface DragGripProps {
  /** `PanResponder`'s handlers, spread onto the view that starts the drag. */
  handlers?: PanResponderInstance['panHandlers']
  /** What a screen reader calls it; the caller owns the wording. */
  accessibilityLabel: string
  testID: string
}

export function DragGrip({ handlers, accessibilityLabel, testID }: DragGripProps) {
  const theme = useTheme()
  const hover = useHover()

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={{
        alignItems: 'center',
        cursor: 'pointer',
        justifyContent: 'center',
        width: DRAG_GRIP_WIDTH
      }}
      testID={testID}
      {...hover.props}
      {...(handlers ?? {})}
    >
      {/*
        The glyph itself is the tint: there is no surface here to wash, and a
        plate appearing under a 26pt column would be a second shape rather than
        a state. Muted → full ink is the same step a row's own hover makes.
      */}
      <Icon color={hover.hovered ? theme.colors.text : theme.colors.textMuted} name="grip" size={ICON_SIZE.control} />
    </View>
  )
}
