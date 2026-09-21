/**
 * The app's own focus ring, for the platform that would otherwise draw one.
 *
 * A browser rings the `<input>`, which is not the control: every editable thing
 * in this app is a TEXT BOX INSIDE A PILL, and the input's own box is the text
 * line — 20pt inside a 44pt search field. So the user agent's ring is a small
 * rectangle floating in the middle of the control it is supposed to be marking,
 * in the system accent, with square corners on a pill. It is not a styling
 * preference: it rings the wrong box.
 *
 * What replaces it is the same ring the design already uses for selection —
 * the accent, at the control's own radius, on the control — and it is applied
 * only while the field has focus. On iOS and Android nothing is suppressed and
 * nothing is drawn: the caret is the focus indicator there, and a second one
 * would be new.
 *
 * Keyboard-versus-pointer is deliberately not distinguished. `:focus-visible`
 * exists because a ring on every mouse click is noise on a page of links; a
 * composer or a search field that somebody has just clicked into is a control
 * they are about to type in, and saying so is not noise.
 */
import { useCallback, useState } from 'react'
import type { TextStyle, ViewStyle } from 'react-native'

import { HAS_USER_AGENT_FOCUS_RING, NO_USER_AGENT_FOCUS_RING } from '../platform/text-field-web'
import { useTheme } from './theme'

/** How thick the ring is, and how far it sits off the control. */
export const FOCUS_RING_WIDTH = 2
export const FOCUS_RING_OFFSET = 2

export interface FocusRing {
  focused: boolean
  /** Spread onto the `TextInput`: tracks focus and suppresses any native ring. */
  fieldProps: {
    // Untyped events: a `TextInput`'s focus and blur events have different
    // shapes on the two platforms and neither half of this reads them.
    onBlur: () => void
    onFocus: () => void
    style: TextStyle
  }
  /**
   * The ring, for the box that IS the control — the pill, not the input.
   *
   * `{}` while unfocused and on every platform that draws its own indicator, so
   * a caller can spread it unconditionally.
   */
  ringStyle: ViewStyle
}

export function useFocusRing(): FocusRing {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)

  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback(() => setFocused(false), [])

  /*
    An OUTLINE rather than a border, and that is the whole reason this is
    drawable at all.

    Every control this rings already has a hairline border of its own, so
    thickening it on focus would move the control's contents by a point and
    unmove them on blur — a pill that twitches when you click into it. An
    outline is painted outside the border box and takes part in no layout, which
    is exactly the job, and it is also what the user agent was using before it
    was pointed at the wrong box.

    `outlineOffset` keeps it clear of the hairline so the two read as one ring
    with a gap rather than as a thick smudge.
  */
  const ring: ViewStyle =
    HAS_USER_AGENT_FOCUS_RING && focused
      ? {
          outlineColor: theme.colors.accentText,
          outlineOffset: FOCUS_RING_OFFSET,
          outlineStyle: 'solid',
          outlineWidth: FOCUS_RING_WIDTH
        }
      : {}

  return {
    focused,
    fieldProps: { onBlur, onFocus, style: NO_USER_AGENT_FOCUS_RING },
    ringStyle: ring
  }
}
