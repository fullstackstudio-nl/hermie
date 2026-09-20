import { useEffect, useState } from 'react'
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
  // Settled, like the collapse: a panel that re-measures itself on every frame of
  // a resize animation is the same stutter by a different route, and the two
  // questions must be asked of ONE number or a window can be mid-resize in one
  // answer and settled in the other.
  return sidebarWidth(useSettledWidth())
}

/**
 * How long a window width has to hold still before it counts as the window's
 * width.
 *
 * A resize animation, a sheet being presented and a Mac window coming back from
 * the background all walk `useWindowDimensions` through values the window never
 * really had. Two frames at 60Hz is 33ms, a UIKit sheet animation is ~300ms of
 * which only the first frames report anything odd; 150ms sits above the noise and
 * below anything a hand can do on a resize handle.
 */
const WIDTH_SETTLE_MS = 150

/**
 * The window's width, once it has stopped moving.
 *
 * This is the whole of "the sidebar collapsed by itself on the Mac". Nothing was
 * flipping: `resolveSidebarCollapsed` is a comparison against one number and a
 * still window cannot produce two answers. The number was the problem. A window
 * going to the background, a sheet being presented and a live resize each push
 * intermediate widths through `useWindowDimensions`, and one of them dipping under
 * 900 for a frame is indistinguishable, to a function that compares, from the
 * owner dragging the window narrow.
 *
 * So the comparison is fed a width that HELD. Every intermediate value restarts
 * the timer, and a width that is not a real one at all — zero, negative, or the
 * `NaN` a detached window has been seen to report — never starts one, so the last
 * good width stands rather than being replaced by a measurement of nothing.
 */
export function useSettledWidth(): number {
  const { width } = useWindowDimensions()
  const [settled, setSettled] = useState(width)

  useEffect(() => {
    if (width === settled || !Number.isFinite(width) || width <= 0) {
      return
    }

    const timer = setTimeout(() => setSettled(width), WIDTH_SETTLE_MS)

    return () => clearTimeout(timer)
  }, [settled, width])

  return settled
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
  // The SETTLED width, not the live one. Everything the two answers are used for
  // is a panel appearing or disappearing, and neither should happen because a
  // window was mid-animation — see `useSettledWidth`.
  const width = useSettledWidth()
  const choice = useChatLayoutStore(state => state.sidebarCollapsed)

  return {
    collapsed: resolveSidebarCollapsed(choice, width),
    overlays: width < SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH
  }
}
