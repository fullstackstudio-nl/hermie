import { Platform, useWindowDimensions } from 'react-native'

import { REGULAR_LAYOUT_MIN_WIDTH } from '../ui/tokens'

export type LayoutMode = 'compact' | 'regular'

/**
 * `compact` is a single navigation stack (phone, narrow iPad split view);
 * `regular` is sidebar plus detail. macOS is always regular — the window can be
 * resized below the threshold, but a desktop window with a stack navigator
 * reads as a phone app blown up.
 */
export function useLayoutMode(): LayoutMode {
  const { width } = useWindowDimensions()

  if (Platform.OS === 'macos') {
    return 'regular'
  }

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? 'regular' : 'compact'
}
