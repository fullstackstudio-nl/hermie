import { useWindowDimensions } from 'react-native'

import { resolveSidebarCollapsed, useChatLayoutStore } from '../store/chat-layout'
import { REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH, sidebarWidth } from '../ui/tokens'

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

/**
 * Whether the sidebar is collapsed right now, and whether hiding it at this width
 * means a rail or an overlay.
 *
 * Both answers come from the same window measurement, which is why they are one
 * hook: a shell that read the collapse from here and the band from somewhere else
 * would be two readings of one number.
 *
 * `overlays` is the second half of the owner's decision. Below 900pt the chat
 * column is the thing worth protecting, so asking for the list back must not push
 * the chat aside again — it lays the list OVER it and takes it away on the next
 * tap. At 900 and above there is room for both, so Show simply shows.
 */
export function useSidebarState(): { collapsed: boolean; overlays: boolean } {
  const { width } = useWindowDimensions()
  const choice = useChatLayoutStore(state => state.sidebarCollapsed)

  return {
    collapsed: resolveSidebarCollapsed(choice, width),
    overlays: width < SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH
  }
}
