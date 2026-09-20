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
 *  2. the list never scrolls ITSELF when a row comes or goes, at either end of
 *     that switch.
 *
 * The typing bubble used to be pinned outside the scroll view and is a CELL now,
 * at index 0, which on an inverted list is the bottom of the conversation. That
 * is only safe because of (1): its height arriving is an insertion like any
 * other, corrected where the reader is up in the history and free where they are
 * at the bottom. So the dots come with their own pair of cases below — inserted
 * and removed, away and at the bottom — and they are the same cases a message
 * row gets.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { FlatList } from 'react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import { holdCorrection } from '../../src/chat-ui/TranscriptList'
import type { AssistantItem, VisibleItem } from '../../src/chat-ui/types'
import { markdownLeading } from '../../src/markdown'
import { FOLD_LINES, type as typeScale } from '../../src/ui/tokens'
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

  it('carries the typing bubble as a cell, so it scrolls with the conversation', () => {
    // The dots were a pinned sibling below the scroll view for as long as the
    // anchor was held at the bottom. They are a row now, and a row is inside.
    renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />)

    const scroll = screen.getByTestId('transcript-list-scroll')

    expect(within(scroll, screen.getByTestId('transcript-list-typing-slot'))).toBe(true)
    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
  })

  it('draws no typing row at all once the turn has a bubble of its own', () => {
    // §6.2: one bubble from start to finish. The streaming reply holds the dots,
    // so the row must not exist beside it — an empty row at index 0 is content
    // whose height comes and goes for nothing.
    renderScreen(
      <TranscriptList
        items={[...visible([userItem]), { item: thinking, presentation: 'full' }]}
        subagents={subagentMap}
        typing
      />
    )

    expect(screen.queryByTestId('transcript-list-typing-slot')).toBeNull()
  })
})

/**
 * The typing row, inserted and removed, in both anchor states.
 *
 * This is the whole of what moving it into the list had to prove: at the bottom
 * the list must not move because there is no anchor and inversion pins offset 0;
 * away from the bottom it must not move ITSELF either — the correction there is
 * the native anchor's, applied inside the scroll view, and any `scrollToOffset`
 * from JavaScript on top of it is a second, visible jump.
 */
describe('the typing row coming and going', () => {
  const body = (extra: { typing?: boolean } = {}) => (
    <TranscriptList items={visible([userItem, assistantItem])} subagents={subagentMap} {...extra} />
  )

  function watchScroll(): jest.SpyInstance {
    return jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
  }

  it('moves nothing while the reader is scrolled away, in or out', () => {
    const scrollToOffset = watchScroll()

    try {
      const view = renderScreen(body())

      scrollTo(400)
      expect(anchorProp()).toEqual({ minIndexForVisible: 0 })
      scrollToOffset.mockClear()

      // In: a row appears at index 0 under a reader who is not looking at it.
      view.rerender(withProviders(body({ typing: true })))
      scrollTo(400)
      expect(anchorProp()).toEqual({ minIndexForVisible: 0 })
      expect(scrollToOffset).not.toHaveBeenCalled()

      // Out: the reply arrives and the dots go with it.
      view.rerender(withProviders(body()))
      scrollTo(400)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('moves nothing while the reader is at the bottom, in or out', () => {
    const scrollToOffset = watchScroll()

    try {
      const view = renderScreen(body())

      scrollTo(0)
      scrollToOffset.mockClear()

      view.rerender(withProviders(body({ typing: true })))
      scrollTo(0)
      expect(anchorProp()).toBeUndefined()
      expect(scrollToOffset).not.toHaveBeenCalled()

      view.rerender(withProviders(body()))
      scrollTo(0)
      expect(anchorProp()).toBeUndefined()
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })
})

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}

/**
 * The second half of the same invariant, for the reader rather than for a turn.
 *
 * **Opening a disclosure must not move the text the reader is looking at.** That
 * is NOT the same as leaving the offset alone, and believing it was is how the
 * owner reported `Show more` twice. An inverted list pins a growing cell's
 * BOTTOM edge, so a body that opens grows upward and carries the line under the
 * finger up with it; leaving the offset where it was keeps the END of the
 * message on screen. Keeping the message's TOP still means moving the offset by
 * exactly the growth — which is why `holdCorrection` takes a target rather than
 * a memory, and why `Fold` reports how much taller it is about to be.
 */
describe('holdCorrection', () => {
  it('asks for nothing while no place is held', () => {
    expect(holdCorrection(undefined, 0)).toBeUndefined()
    expect(holdCorrection(undefined, 940)).toBeUndefined()
  })

  it('asks for nothing when the offset did not move — the delta a fold must have', () => {
    expect(holdCorrection(420, 420)).toBeUndefined()
  })

  it('treats sub-point drift as rounding, the way UIKit does', () => {
    expect(holdCorrection(420, 420.4)).toBeUndefined()
    expect(holdCorrection(420, 419.6)).toBeUndefined()
  })

  it('puts the list back when the expansion moved it', () => {
    // The reported shape: the growth lands the reader at the newest message.
    expect(holdCorrection(420, 0)).toBe(420)
    expect(holdCorrection(420, 628)).toBe(420)
  })
})

describe('opening a disclosure', () => {
  const HEIGHT = 4000
  const long = { ...assistantItem, id: 'a-long', streaming: false, text: 'x'.repeat(HEIGHT) }

  /** The clip the fold applies, so the growth it reports can be named exactly. */
  const limit = FOLD_LINES.regular * markdownLeading(typeScale.body.fontSize)
  const growth = HEIGHT - limit

  /** One layout pass for a row, the way the list hears about it. */
  function layoutRow(id: string, height: number): void {
    act(() => {
      fireEvent(screen.getByTestId(`transcript-row-${id}`), 'layout', { nativeEvent: { layout: { height } } })
    })
  }

  function press(): void {
    act(() => {
      fireEvent(screen.getByTestId(`assistant-fold-${long.id}-body`), 'layout', {
        nativeEvent: { layout: { height: HEIGHT } }
      })
    })

    fireEvent.press(screen.getByTestId(`assistant-fold-${long.id}-toggle`))
  }

  it('moves the reader by the growth, so the message opens downward', () => {
    // The owner's report, twice over: `Show more` still threw the transcript to
    // the end of the message. An inverted list pins a growing cell's BOTTOM
    // edge, so holding the offset the finger went down at keeps the END of the
    // message under the finger and sends everything the reader was reading up
    // and off the screen. The target is that offset PLUS the growth, which
    // keeps the message's top edge still.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      // The growth lands them somewhere else; the list puts them where the top
      // of the message still is.
      scrollTo(0)
      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 420 + growth })

      // A drag is the reader deciding where to be, and outranks the hold.
      scrollToOffset.mockClear()
      fireEvent(screen.getByTestId('transcript-list-scroll'), 'scrollBeginDrag')
      scrollTo(0)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('never leaves the reader at the end of the message they just opened', () => {
    // The shape of the bug as reported: at the bottom of the conversation the
    // held offset was zero, and zero on an inverted list is the newest content —
    // the END of the reply they had just asked to read.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(0)
      press()
      scrollToOffset.mockClear()
      scrollTo(0)

      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: growth })
      expect(scrollToOffset).not.toHaveBeenCalledWith({ animated: false, offset: 0 })
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('follows a row that grows in two stages, not just the one it predicted', () => {
    // The owner's third report: `Show more` on a message containing a TABLE
    // still moved the text up by about 212pt. `Fold` measures its own unclipped
    // body and can say how much taller the text is about to be — but the table
    // measures its columns a pass later, and that second stage was in nobody's
    // number. So the prediction is the first estimate and every frame the row
    // reports after it is measured.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})
    const TABLE = 212

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      // Stage one: the row reports the height the fold already predicted. That
      // is the baseline, and it must move nothing.
      layoutRow(long.id, 1000)
      expect(scrollToOffset).not.toHaveBeenCalled()

      // Stage two: the table arrives.
      layoutRow(long.id, 1000 + TABLE)
      expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 420 + growth + TABLE })

      // And a third pass that changes nothing asks for nothing.
      scrollToOffset.mockClear()
      layoutRow(long.id, 1000 + TABLE)
      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('stops measuring once the hold has been let go', () => {
    // The window is `HOLD_SETTLE_MS`. A row that goes on changing height after
    // it — an image landing, a stream continuing — is not the expansion the
    // reader asked for, and must not move them.
    jest.useFakeTimers()

    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      layoutRow(long.id, 1000)

      act(() => {
        jest.advanceTimersByTime(1000)
      })

      scrollToOffset.mockClear()
      layoutRow(long.id, 1600)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
      jest.useRealTimers()
    }
  })

  it('lets the held place go when the typing row arrives under it', () => {
    // A hold is a promise about ONE expansion. The dots are a row now, so their
    // arrival changes the content by their own height as well — and forcing the
    // offset to a target computed before that row existed would undo the
    // correction the anchor just made and move the reader by the row's height.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      const view = renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()

      view.rerender(withProviders(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} typing />))
      scrollTo(0)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('corrects nothing once the reader is already where they belong', () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderScreen(<TranscriptList items={visible([userItem, long])} subagents={subagentMap} />)

      scrollTo(420)
      press()
      scrollToOffset.mockClear()
      scrollTo(420 + growth)

      expect(scrollToOffset).not.toHaveBeenCalled()
    } finally {
      scrollToOffset.mockRestore()
    }
  })
})
