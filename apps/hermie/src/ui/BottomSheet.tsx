/**
 * The app's bottom sheet on iOS and Android: `Modal` + `Animated`, and nothing
 * else.
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
 *
 * macOS has no `Modal` either, so it gets `BottomSheet.macos.tsx` beside this
 * file. Everything the two share lives in `bottom-sheet/SheetBody.tsx`.
 */
import { Modal } from 'react-native'

import { SheetBody, sheetMaxHeight, useSheetPresence, type BottomSheetProps } from './bottom-sheet/SheetBody'

export { SheetEyebrow } from './bottom-sheet/SheetBody'
export type { BottomSheetProps }

export function BottomSheet({ visible, onClosed, ...rest }: BottomSheetProps) {
  const { mounted, progress } = useSheetPresence(visible, onClosed)

  if (!mounted) {
    return null
  }

  return (
    <Modal
      animationType="none"
      // Android draws the sheet's own backdrop behind the system bars rather
      // than leaving two opaque strips above and below a dimmed screen. The
      // navigation-bar flag is only honoured together with the status-bar one.
      navigationBarTranslucent
      onRequestClose={rest.blocking ? undefined : rest.onRequestClose}
      statusBarTranslucent
      transparent
      visible={mounted}
    >
      <SheetBody {...rest} maxHeight={sheetMaxHeight()} progress={progress} />
    </Modal>
  )
}
