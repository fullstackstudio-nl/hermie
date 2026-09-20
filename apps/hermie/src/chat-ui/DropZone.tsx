/**
 * The region of the chat that takes a dragged file.
 *
 * It wraps the transcript and the composer together rather than either one
 * alone, because "drop it on the conversation" is what a reader means and
 * aiming at a 44pt field with a file in hand is not. `UIDropInteraction` does
 * the accepting; this is the seam and the feedback.
 *
 * ## The overlay is the whole point of `onDropEnter`
 *
 * A drop target with no feedback is one a person tries twice. The owner's
 * reference is iMessage: while a file is held over the window the conversation
 * dims behind a dashed, accent-tinted panel that says what letting go will do,
 * and the panel goes the moment the drag leaves or lands.
 *
 * It is `pointerEvents="none"` throughout, which is not a detail: an overlay
 * that took the drop it is advertising would swallow the gesture and the
 * attachment would never arrive.
 *
 * ## Inert is the DEFAULT, not a branch
 *
 * On an iPhone there is no drag session to receive, and on Android and the web
 * there is no view at all. All three render the children bare — no wrapper view,
 * no callbacks, nothing in the tree — which is also what the test renderer sees,
 * so a screen's snapshot does not change shape because a native module exists
 * somewhere else.
 */
import { useState, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { nativeDropView, normaliseDroppedFiles, type DroppedFile } from '../platform/file-drop'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { SCRIM_COLOR } from '../ui/tokens'
import { chatStrings } from './strings'

export interface DropZoneProps {
  /** Every file in one drop, in the order they were dragged. Never empty. */
  onFiles: (files: DroppedFile[]) => void
  /** False while the chat cannot take an attachment — signed out, no session. */
  enabled?: boolean
  style?: StyleProp<ViewStyle>
  children: ReactNode
  testID?: string
}

export function DropZone({ children, enabled = true, onFiles, style, testID = 'drop-zone' }: DropZoneProps) {
  const theme = useTheme()
  const [over, setOver] = useState(false)
  const Native = nativeDropView()

  if (!Native) {
    return style ? <View style={style}>{children}</View> : <>{children}</>
  }

  return (
    <Native
      enabled={enabled}
      onDrop={event => {
        // The highlight comes off HERE as well as on `onDropExit`: the exit
        // event arrives from the same gesture and the order is UIKit's, so a
        // drop that outran it would otherwise leave the outline on screen.
        setOver(false)

        const files = normaliseDroppedFiles(event.nativeEvent?.files)

        if (files.length) {
          onFiles(files)
        }
      }}
      onDropEnter={() => setOver(true)}
      onDropExit={() => setOver(false)}
      style={style}
      testID={testID}
    >
      {children}

      {over ? (
        <View
          accessibilityLabel={chatStrings.drop.region}
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, { padding: theme.space.md }]}
          testID={`${testID}-overlay`}
        >
          {/* The dim is its own layer under the panel, so the panel's own
              border and label stay at full strength over it. */}
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, { backgroundColor: SCRIM_COLOR }]}
            testID={`${testID}-dim`}
          />

          <View
            pointerEvents="none"
            style={{
              alignItems: 'center',
              borderColor: theme.colors.accent,
              borderRadius: theme.radii.sheet,
              borderStyle: 'dashed',
              borderWidth: 2,
              flex: 1,
              justifyContent: 'center'
            }}
            testID={`${testID}-highlight`}
          >
            <Text color="onAccent" variant="sheetTitle">
              {chatStrings.drop.invitation}
            </Text>
          </View>
        </View>
      ) : null}
    </Native>
  )
}
