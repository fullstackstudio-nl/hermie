/**
 * How wide a bubble is allowed to get, measured against the COLUMN it is in.
 *
 * The rule in `design/liquid-glass-tokens.md` §4 is a percentage and a point
 * ceiling, and the percentage is of the chat column. Until this round the
 * percentage lived in the style as `maxWidth: '68%'` on a bubble whose parent
 * was sized by its own `maxWidth` — so Yoga had no base to resolve it against
 * and dropped it, leaving the point cap as the only rule that ever applied. On
 * a 1376pt iPad window that made every bubble exactly 435pt wide no matter how
 * wide the column was, which is what the owner saw and reported as "compact
 * bubbles on a wide window".
 *
 * So the numbers below are absolute points, deliberately: a percentage in a
 * style is a rule nobody can assert, and this file exists because that is how
 * the bug survived two rounds of component tests.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native'

import { Bubble, BubbleColumn, resolveBubbleWidth, useBubbleWidth } from '../../src/chat-ui'
import { Text } from '../../src/ui/primitives'
import { BUBBLE_MAX, REGULAR_LAYOUT_MIN_WIDTH, SIDEBAR_WIDTH, WINDOW_GAP } from '../../src/ui/tokens'
import { renderScreen } from '../support/render'

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13" in landscape, which is what the Mac window reports as well. */
const LANDSCAPE = { width: 1376, height: 1032 }
/** The same device portrait, where 68 % of the column is what binds. */
const PORTRAIT = { width: 1032, height: 1376 }
/** iPhone 17 Pro. */
const PHONE = { width: 402, height: 874 }

function Probe() {
  const max = useBubbleWidth()

  return <Text testID="cap">{String(max)}</Text>
}

/** Render one bubble's cap inside a column of `columnWidth`, once laid out. */
function capInColumn(columnWidth: number): number {
  renderScreen(
    <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
      <Probe />
    </BubbleColumn>
  )

  fireEvent(screen.getByTestId('column'), 'layout', {
    nativeEvent: { layout: { width: columnWidth, height: 800, x: 0, y: 0 } }
  })

  return Number(screen.getByTestId('cap').props.children)
}

describe('the cap on the wide layout', () => {
  it('is 68 % of the CHAT COLUMN, not of the window', () => {
    size(PORTRAIT.width, PORTRAIT.height)

    // The column beside the sidebar: the window less the sidebar, the gap
    // between the panels and the window padding on each side.
    const column = PORTRAIT.width - (SIDEBAR_WIDTH + WINDOW_GAP * 3)
    const percentage = Math.round((column * BUBBLE_MAX.regular.percent) / 100)

    expect(capInColumn(column)).toBe(percentage)

    // And the window is wide enough that reading the rule off IT would have
    // produced the ceiling instead — which is the bug this replaced.
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, PORTRAIT.width)).toBe(BUBBLE_MAX.regular.points)
  })

  it('stops at the point ceiling on a landscape window, where the column is wide enough', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)

    // The 640pt ceiling has never been verified on a device — the previous
    // round could not produce a landscape window at all. At 1376pt it bites
    // even beside the sidebar, which is the case worth holding still.
    const column = LANDSCAPE.width - (SIDEBAR_WIDTH + WINDOW_GAP * 3)

    expect(capInColumn(column)).toBe(BUBBLE_MAX.regular.points)
    expect(capInColumn(LANDSCAPE.width)).toBe(BUBBLE_MAX.regular.points)
  })

  it('does not fall back to the compact rule because the COLUMN is under the threshold', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)

    // 646pt is narrower than the 700pt layout threshold, and the compact rule
    // would cap it at 320. The layout is wide; the column is merely a column.
    expect(capInColumn(646)).toBeGreaterThan(BUBBLE_MAX.compact.points)
  })
})

describe('the cap on a phone', () => {
  it('is the phone percentage of the window, which is the whole column there', () => {
    size(PHONE.width, PHONE.height)

    expect(capInColumn(PHONE.width)).toBe(Math.round((PHONE.width * BUBBLE_MAX.compact.percent) / 100))
  })

  it('never reaches the compact ceiling on any phone this app supports', () => {
    size(PHONE.width, PHONE.height)

    expect(capInColumn(PHONE.width)).toBeLessThan(BUBBLE_MAX.compact.points)
  })
})

describe('before the column has been laid out', () => {
  it('falls back to the window, so the first frame is not zero-width', () => {
    size(PHONE.width, PHONE.height)
    renderScreen(
      <View>
        <Probe />
      </View>
    )

    expect(Number(screen.getByTestId('cap').props.children)).toBe(resolveBubbleWidth(BUBBLE_MAX.compact, PHONE.width))
  })
})

describe('the rule itself', () => {
  it('is the smaller of the percentage and the ceiling, both halves live', () => {
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, 500)).toBe(340)
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, 2000)).toBe(BUBBLE_MAX.regular.points)
    expect(REGULAR_LAYOUT_MIN_WIDTH).toBeGreaterThan(0)
  })
})

describe('the bubble itself', () => {
  it('carries the cap as points, never as a percentage nothing can resolve', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    renderScreen(
      <BubbleColumn style={{ flex: 1 } as ViewStyle} testID="column">
        <Bubble side="other" testID="bubble">
          <Text>Hello</Text>
        </Bubble>
      </BubbleColumn>
    )

    fireEvent(screen.getByTestId('column'), 'layout', {
      nativeEvent: { layout: { width: 1000, height: 800, x: 0, y: 0 } }
    })

    const style = StyleSheet.flatten(screen.getByTestId('bubble').props.style as never) as { maxWidth?: unknown }

    expect(style.maxWidth).toBe(resolveBubbleWidth(BUBBLE_MAX.regular, 1000))
    expect(typeof style.maxWidth).toBe('number')
  })
})
