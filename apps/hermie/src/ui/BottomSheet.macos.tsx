/**
 * The bottom sheet on macOS, where `Modal` does not exist.
 *
 * `React/Views/RCTModalHostView.m` in react-native-macos is wrapped in
 * `#if !TARGET_OS_OSX`, so there is no `RCTModalHostView` view manager on a
 * Mac and every `<Modal>` red-boxes the moment it mounts. That took out every
 * sheet in the app — options, agents, approval, clarify — on the one platform
 * where they were hardest to notice, because the gallery is the only screen
 * that can open one without typing.
 *
 * The replacement is an absolutely positioned overlay filling the screen the
 * sheet was rendered into, with the same backdrop and the same panel. It is
 * deliberately NOT a portal: there is no portal host in this app, and the
 * sheets are already rendered as the last children of a `Screen`, which is the
 * full-bleed box they need to cover.
 *
 * `./bottom-sheet/SheetBody` is imported rather than `./BottomSheet`: inside a
 * `.macos` file the latter specifier resolves back to THIS file (see
 * "Platform-variant modules resolve to themselves" in
 * `docs/platform-notes.md`), which is a self-referencing getter and a stack
 * overflow at startup.
 */
import { StyleSheet, View } from 'react-native'

import { SheetBody, sheetMaxHeight, useSheetPresence, type BottomSheetProps } from './bottom-sheet/SheetBody'

export { SheetEyebrow } from './bottom-sheet/SheetBody'
export type { BottomSheetProps }

/**
 * AppKit swallows Escape unless the view is told to pass it up, through the
 * macOS-only `keyDownEvents`/`onKeyDown` pair. Neither prop exists in the
 * `react-native` typings this repo compiles against — the macOS ones live in
 * `react-native-macos` — so they are spread in rather than written inline, the
 * same way `Composer` does it for the text field.
 */
function escapeKeyProps(onEscape: () => void): Record<string, unknown> {
  return {
    focusable: true,
    keyDownEvents: [{ key: 'Escape' }],
    onKeyDown: (event: { nativeEvent?: { key?: string } }) => {
      if (event.nativeEvent?.key === 'Escape') {
        onEscape()
      }
    }
  }
}

export function BottomSheet({ visible, onClosed, ...rest }: BottomSheetProps) {
  const { mounted, progress } = useSheetPresence(visible, onClosed)

  if (!mounted) {
    return null
  }

  return (
    <View
      // `box-none` on the wrapper alone would let taps through the gap above
      // the panel; the backdrop inside `SheetBody` is a real Pressable that
      // fills that gap, so the overlay stays interactive all the way up.
      style={[StyleSheet.absoluteFillObject, { zIndex: 1000 }]}
      {...(rest.blocking ? {} : escapeKeyProps(rest.onRequestClose))}
    >
      <SheetBody {...rest} maxHeight={sheetMaxHeight()} progress={progress} />
    </View>
  )
}
