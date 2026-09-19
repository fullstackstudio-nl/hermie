/**
 * Who gets Escape.
 *
 * Escape arrives as one global event from the keyboard seam — it has to, because
 * it inserts no text and so never reaches a text field's delegate on iOS, and
 * because a `UIKeyCommand` would sit in a responder chain that a presented
 * `Modal` leaves. That leaves the routing to JavaScript, and the rule is the one a
 * reader expects: the thing that opened last closes first.
 *
 * The case worth the most care is the blocking sheet. ADR-0010 says an agent's
 * question is answered by an explicit tap, so Escape must not dismiss it — and
 * must not fall through to whatever is underneath either, or it would stop the
 * very turn that is waiting for the answer.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'
import { Pressable, Text } from 'react-native'

import { OverlayPanel } from '../src/app/OverlayPanel'
import { BottomSheet } from '../src/ui/BottomSheet'
import { useEscapeKey } from '../src/ui/useEscapeKey'
import { renderScreen, withProviders } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

/** Press Escape, the way the native module would deliver it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

beforeEach(() => mockEscapeListeners.clear())

function Taker({ label, enabled = true, onEscape }: { label: string; enabled?: boolean; onEscape: () => void }) {
  useEscapeKey(onEscape, enabled)

  return <Text>{label}</Text>
}

describe('useEscapeKey', () => {
  it('holds exactly one native subscription for the whole stack', () => {
    const view = render(
      <>
        <Taker label="one" onEscape={jest.fn()} />
        <Taker label="two" onEscape={jest.fn()} />
      </>
    )

    expect(mockEscapeListeners.size).toBe(1)

    view.unmount()
    expect(mockEscapeListeners.size).toBe(0)
  })

  it('gives the key to whatever registered last', () => {
    const first = jest.fn()
    const second = jest.fn()

    render(
      <>
        <Taker label="one" onEscape={first} />
        <Taker label="two" onEscape={second} />
      </>
    )

    pressEscape()

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('hands it back when the top one leaves', () => {
    const first = jest.fn()
    const second = jest.fn()

    const view = render(
      <>
        <Taker label="one" onEscape={first} />
        <Taker enabled label="two" onEscape={second} />
      </>
    )

    view.rerender(
      <>
        <Taker label="one" onEscape={first} />
        <Taker enabled={false} label="two" onEscape={second} />
      </>
    )

    pressEscape()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('does nothing at all when nothing is registered', () => {
    pressEscape()

    expect(mockEscapeListeners.size).toBe(0)
  })

  it('calls the current handler, not the one from the render that registered', () => {
    const stale = jest.fn()
    const fresh = jest.fn()

    const view = render(<Taker label="one" onEscape={stale} />)
    view.rerender(<Taker label="one" onEscape={fresh} />)

    pressEscape()

    expect(fresh).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })
})

describe('BottomSheet and Escape', () => {
  it('dismisses an ordinary sheet', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    pressEscape()

    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss a blocking sheet', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet blocking onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    pressEscape()

    expect(onRequestClose).not.toHaveBeenCalled()
  })

  /**
   * The load-bearing half of the rule. A blocking sheet SWALLOWS Escape: if it
   * merely ignored the key, the handler underneath would get it, and underneath
   * an approval sheet is the composer running the turn that asked the question.
   */
  it('swallows Escape rather than letting it through to what is underneath', () => {
    const underneath = jest.fn()
    const onRequestClose = jest.fn()

    render(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet blocking onRequestClose={onRequestClose} testID="sheet" visible>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    pressEscape()

    expect(underneath).not.toHaveBeenCalled()
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('gives Escape back once the sheet has gone', async () => {
    const underneath = jest.fn()

    const view = render(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    view.rerender(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible={false}>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    // The sheet keeps the key while it slides out, because it is still on screen.
    expect(screen.getByTestId('sheet')).toBeTruthy()
    pressEscape()
    expect(underneath).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull())

    pressEscape()
    expect(underneath).toHaveBeenCalledTimes(1)
  })
})

/**
 * Escape goes back ONE level.
 *
 * The overlay panel that carries Activity, Crons and Settings on the wide layout
 * holds Escape while it is open. A sub page inside it — a cron's detail, a run
 * transcript, the connection test — registers on top when it opens, so the first
 * Escape returns to the page underneath and only the second closes the panel.
 *
 * Nothing coordinates that. It falls out of mount order, which is exactly what
 * the stack is for, and this is the test that says so.
 */
function SubPage() {
  const [open, setOpen] = useState(false)

  // The shape every sub page in the app uses; see `CronScreen` and
  // `SettingsScreen`.
  useEscapeKey(() => setOpen(false), open)

  return (
    <>
      <Pressable onPress={() => setOpen(true)} testID="open-sub-page">
        <Text>Open</Text>
      </Pressable>
      {open ? <Text testID="sub-page">Sub page</Text> : null}
    </>
  )
}

describe('Escape inside the overlay panel', () => {
  it('closes the panel when nothing is open inside it', async () => {
    const onClose = jest.fn()

    renderScreen(
      <OverlayPanel onClose={onClose} title="Settings" visible>
        <SubPage />
      </OverlayPanel>
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pops the sub page first and leaves the panel open', () => {
    const onClose = jest.fn()

    renderScreen(
      <OverlayPanel onClose={onClose} title="Settings" visible>
        <SubPage />
      </OverlayPanel>
    )

    fireEvent.press(screen.getByTestId('open-sub-page'))
    expect(screen.getByTestId('sub-page')).toBeTruthy()

    pressEscape()

    expect(screen.queryByTestId('sub-page')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // And only now does the panel get it.
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
