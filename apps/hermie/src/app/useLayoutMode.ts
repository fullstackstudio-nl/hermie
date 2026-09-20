import { useWindowDimensions } from 'react-native'

import { REGULAR_LAYOUT_MIN_WIDTH, sidebarWidth } from '../ui/tokens'

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

/**
 * How wide the sidebar is in this window.
 *
 * A SECOND breakpoint, above the one that picks the shell, and the reason it is
 * not folded into `LayoutMode`: whether there are two panels and how wide the
 * first one is are different questions with different answers. Every window from
 * 700 to a Mac full screen is `regular`, and the 11" portrait end of that range
 * is where 344 stopped being a sidebar and started being a third of the screen.
 */
export function useSidebarWidth(): number {
  const { width } = useWindowDimensions()

  return sidebarWidth(width)
}
