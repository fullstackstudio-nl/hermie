/**
 * The fold, and the reason its state does not live in the row.
 *
 * A disclosure that keeps its own `useState` is a bug with a delay on it: in a
 * virtualised list, scrolling an opened card out of the window unmounts the row, so
 * scrolling back re-mounts it collapsed. Nothing the reader did.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { useState } from 'react'
import { Text as RNText, View } from 'react-native'

import { ExpandedProvider, Fold, needsReadingTreatment, useExpanded } from '../../src/chat-ui'
import { renderScreen } from '../support/render'

/** A row that can be unmounted and re-mounted, the way `FlatList` does it. */
function Row({ id }: { id: string }) {
  const [expanded, toggle] = useExpanded(id)

  return (
    <View>
      <RNText onPress={toggle} testID={`toggle-${id}`}>
        toggle
      </RNText>
      <RNText testID={`state-${id}`}>{expanded ? 'open' : 'closed'}</RNText>
    </View>
  )
}

function Harness() {
  const [mounted, setMounted] = useState(true)

  return (
    <ExpandedProvider>
      <RNText onPress={() => setMounted(current => !current)} testID="virtualise">
        virtualise
      </RNText>
      {mounted ? <Row id="item-1" /> : null}
      <Row id="item-2" />
    </ExpandedProvider>
  )
}

describe('per-item expanded state', () => {
  it('survives the row being virtualised out and back', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))
    expect(screen.getByTestId('state-item-1').props.children).toBe('open')

    // Unmount the row, the way the list does when it scrolls out of the window.
    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.queryByTestId('state-item-1')).toBeNull()

    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.getByTestId('state-item-1').props.children).toBe('open')
  })

  it('keeps one item’s state out of another’s', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))

    expect(screen.getByTestId('state-item-1').props.children).toBe('open')
    expect(screen.getByTestId('state-item-2').props.children).toBe('closed')
  })

  it('closes again on a second tap', () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByTestId('toggle-item-1'))
    fireEvent.press(screen.getByTestId('toggle-item-1'))

    expect(screen.getByTestId('state-item-1').props.children).toBe('closed')
  })
})

describe('Fold', () => {
  /**
   * The test renderer lays nothing out, so `onLayout` never fires on its own and
   * the natural height stays 0. Firing it by hand is the only way to reach the
   * overflowing branch at all — which is also the honest limit of this test: it
   * proves the decision, not the pixels.
   */
  function renderFold(height: number, streaming = false) {
    renderScreen(
      <ExpandedProvider>
        <Fold expanded={false} fadeTo="#ffffff" onToggle={jest.fn()} streaming={streaming} testID="fold">
          <RNText>body</RNText>
        </Fold>
      </ExpandedProvider>
    )

    act(() => {
      fireEvent(screen.getByTestId('fold').props.children, 'layout', { nativeEvent: { layout: { height } } })
    })
  }

  it('offers no control for a body that fits', () => {
    renderScreen(
      <ExpandedProvider>
        <Fold expanded={false} fadeTo="#ffffff" onToggle={jest.fn()} testID="fold">
          <RNText>short</RNText>
        </Fold>
      </ExpandedProvider>
    )

    expect(screen.queryByTestId('fold-toggle')).toBeNull()
  })

  // Never fold the message that is currently streaming: a fold appearing mid-stream
  // clips the words being written, and a "Show more" that then grows past the fold
  // on its own is worse than no fold.
  it('never folds a streaming body', () => {
    renderFold(4000, true)

    expect(screen.queryByTestId('fold-toggle')).toBeNull()
  })
})

describe('needsReadingTreatment', () => {
  it('leaves a short reply frosted', () => {
    expect(needsReadingTreatment('Done.')).toBe(false)
  })

  it('promotes a long one', () => {
    expect(needsReadingTreatment('x'.repeat(600))).toBe(true)
  })

  // A fenced block or a table qualifies at any length: both are wide machine text
  // that has to sit on a known surface to be readable at all.
  it('promotes a fenced block or a table however short', () => {
    expect(needsReadingTreatment('```\nnpm test\n```')).toBe(true)
    expect(needsReadingTreatment('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true)
  })
})
