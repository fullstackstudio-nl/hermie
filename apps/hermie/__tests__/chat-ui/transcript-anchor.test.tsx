/**
 * The one invariant behind "the chat jumps up and scrolls back".
 *
 * **While the reader is at the bottom, a streaming turn must never change the
 * visible offset except by growing the content.**
 *
 * That is not a thing a test renderer can watch, because the correction happens in
 * `RCTScrollViewComponentView`, in two steps around a mounting transaction:
 *
 * ```objc
 * // _prepareForMaintainVisibleScrollPosition, BEFORE the update
 * hasNewView = subview.frame.origin.y + subview.frame.size.height > contentOffset.y
 * // _adjustForMaintainVisibleContentPosition, AFTER it
 * deltaY = _firstVisibleView.frame.origin.y - _prevFirstVisibleFrame.origin.y
 * if (ABS(deltaY) > 0.5) { contentOffset.y += deltaY; if (y <= threshold) scrollToOffset(0, animated) }
 * ```
 *
 * The anchor is a VIEW, and at the bottom of an inverted list every new row is
 * inserted before it, so `deltaY` is the new row's own height. A previous round
 * tried to give that loop a constant view to hold — a one-point
 * `ListHeaderComponent` — and it cannot work: `VirtualizedList` adds one to
 * `minIndexForVisible` whenever a header exists, so the loop starts at the first
 * CELL and the header is unreachable at any value of the prop. Measured on an
 * iPhone 17 Pro with `--hermieTraceScroll`: a 70pt outgoing bubble moved the
 * offset from 0 to 94 and it took ~290ms to animate back.
 *
 * So the invariant is expressed here as the two structural facts it reduces to,
 * both of which ARE observable from JavaScript:
 *
 *  1. the scroll view holds NO `maintainVisibleContentPosition` while the reader
 *     is at the bottom, so there is nothing to correct and nothing to animate —
 *     and it does hold one once they scroll away, where the correction is the
 *     behaviour a reader wants;
 *  2. nothing whose height changes during a turn is rendered inside the scroll
 *     view before the cells.
 *
 * A change that puts the typing bubble back into the list, or turns the anchor
 * back on at the bottom, breaks one of these two and this file says which.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import type { AssistantItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen, withProviders } from '../support/render'

const visible = (items: { id: string }[]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'collapsed' }) as VisibleItem)

/** The turn as it really arrives: reasoning first, then the first token, then more. */
const thinking: AssistantItem = { ...assistantItem, id: 'a-live', streaming: true, text: '', reasoning: 'Checking…' }
const firstToken: AssistantItem = { ...thinking, text: 'L', version: (thinking.version ?? 0) + 1 }
const moreText: AssistantItem = { ...thinking, text: 'Looking that up', version: (thinking.version ?? 0) + 2 }

/** What the list is holding the scroll view to right now, if anything. */
function anchorProp(): unknown {
  return screen.getByTestId('transcript-list-scroll').props.maintainVisibleContentPosition
}

/** Put the reader `y` points from the bottom of the inverted list. */
function scrollTo(y: number): void {
  fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { height: 2000, width: 402 },
      layoutMeasurement: { height: 800, width: 402 }
    }
  })
}

describe('the list’s anchor', () => {
  it('is held by nothing at the bottom, through a whole streaming turn', () => {
    // Every frame of a turn inserts or grows a row at index 0. With an anchor
    // held, each of those is a correction of exactly that row's height followed
    // by an animated scroll back to zero.
    const view = renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} />)

    expect(anchorProp()).toBeUndefined()

    for (const item of [thinking, firstToken, moreText]) {
      view.rerender(
        withProviders(
          <TranscriptList
            items={[...visible([userItem]), { item, presentation: 'full' }]}
            subagents={subagentMap}
            typing
          />
        )
      )

      expect(anchorProp()).toBeUndefined()
    }

    // And when the turn ends and the typing flag drops with it.
    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: { ...moreText, streaming: false }, presentation: 'full' }]}
          subagents={subagentMap}
        />
      )
    )

    expect(anchorProp()).toBeUndefined()
  })

  it('is held once the reader scrolls away, and let go again at the bottom', () => {
    // The case the prop exists for: a message arriving under a reader who is up
    // in the history must not shove the paragraph they are reading up the screen.
    renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

    scrollTo(400)
    expect(anchorProp()).toEqual({ minIndexForVisible: 0 })

    scrollTo(0)
    expect(anchorProp()).toBeUndefined()
  })

  it('never carries an autoscroll threshold, which is what animated the jump back', () => {
    // `autoscrollToTopThreshold` only ever fires within its own distance of the
    // bottom — which is exactly where the anchor is now let go — so a value here
    // could only ever re-arm the scroll back down.
    renderScreen(<TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} />)

    scrollTo(400)
    expect(anchorProp()).not.toHaveProperty('autoscrollToTopThreshold')
  })

  it('is the only thing between the scroll view and its cells', () => {
    // The typing bubble is what used to sit here, and its height is exactly what
    // moved the first cell. It is a pinned sibling now, so it must NOT be a
    // descendant of the scroll view at all.
    renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />)

    const scroll = screen.getByTestId('transcript-list-scroll')
    const slot = screen.getByTestId('transcript-list-typing-slot')

    expect(within(scroll, slot)).toBe(false)
  })
})

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}
