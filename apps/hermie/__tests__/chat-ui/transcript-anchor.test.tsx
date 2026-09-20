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
 * So the invariant is expressed here as the two structural facts it reduces to,
 * both of which ARE observable from JavaScript:
 *
 *  1. the scroll view's first subview has a CONSTANT, non-zero height, so it wins
 *     the `hasNewView` test at every offset a reader can be at the bottom with and
 *     its origin — always 0 — is what every delta is measured against;
 *  2. nothing whose height changes during a turn is rendered inside the scroll
 *     view before the cells.
 *
 * Together those make `deltaY` identically zero at the bottom, which makes the
 * correction and its animated scroll-back unreachable. A change that puts a
 * variable-height view back into the header, or drops the spacer to zero, breaks
 * one of these two and this file says which.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

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

function anchorHeight(): number {
  const style = StyleSheet.flatten(screen.getByTestId('transcript-list-anchor').props.style) as { height?: number }

  return style.height ?? 0
}

describe('the list’s anchor', () => {
  it('is a constant, non-zero height through a whole streaming turn', () => {
    // Zero is the failing value, and it fails silently: `0 > 0` is false, so the
    // anchor falls through to the first CELL and every change at the bottom moves
    // that cell's origin.
    const view = renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} />)
    const before = anchorHeight()

    expect(before).toBeGreaterThan(0)

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

      expect(anchorHeight()).toBe(before)
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

    expect(anchorHeight()).toBe(before)
  })

  it('keeps its height while the typing bubble comes and goes', () => {
    // The transition that produced the reported jump: a turn starts, the typing
    // bubble appears, and the first reasoning delta replaces it with a streaming
    // reply — three height changes in a row at the bottom of the list.
    const view = renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} />)
    const before = anchorHeight()

    view.rerender(withProviders(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />))
    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
    expect(anchorHeight()).toBe(before)

    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: thinking, presentation: 'full' }]}
          subagents={subagentMap}
          typing
        />
      )
    )

    expect(screen.queryByTestId('typing-indicator')).toBeNull()
    expect(anchorHeight()).toBe(before)
  })

  it('is the only thing between the scroll view and its cells', () => {
    // The typing bubble is what used to sit here, and its height is exactly what
    // moved the anchor. It is a pinned sibling now, so it must NOT be a descendant
    // of the scroll view at all.
    renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />)

    const scroll = screen.getByTestId('transcript-list-scroll')
    const slot = screen.getByTestId('transcript-list-typing-slot')

    expect(screen.getByTestId('transcript-list-anchor')).toBeTruthy()
    expect(within(scroll, slot)).toBe(false)
  })
})

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}
