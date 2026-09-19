import { useWindowDimensions } from 'react-native'

import { REGULAR_LAYOUT_MIN_WIDTH } from '../ui/tokens'

export type LayoutMode = 'compact' | 'regular'

/**
 * `compact` is a single navigation stack (phone, narrow iPad split view);
 * `regular` is sidebar plus detail.
 *
 * The window's width decides, on every platform. A Mac window is the same
 * question as an iPad one — it is the same build (ADR-0011) — so a Mac gets the
 * sidebar shell at any usable window size and folds to the compact stack if it
 * is dragged narrower than two panes fit.
 */
export function useLayoutMode(): LayoutMode {
  const { width } = useWindowDimensions()

  return width >= REGULAR_LAYOUT_MIN_WIDTH ? 'regular' : 'compact'
}
