/**
 * Who gets ⌘K, and what ⌘W is allowed to be.
 *
 * The shortcuts arrive the way Escape does — one global event from a handler below
 * the responder chain, with no notion of what is on screen — so the same question
 * has to be answered again: which of several registered screens takes it. The
 * answer is deliberately the same one, a stack per action, and this file is where
 * the two are held to it.
 *
 * ⌘W is the interesting case. It is defined as "one level, like Esc", so it is NOT
 * registrable: it goes to the Escape stack. A second stack that also claimed to
 * mean "close one level" would be a second stack to keep in agreement with the
 * first, and they would drift the first time a sheet registered on one and not the
 * other.
 */
import { act, render } from '@testing-library/react-native'
import { Text } from 'react-native'

import type { ShortcutAction } from '../src/platform/desktop-shortcuts'
import { useEscapeKey } from '../src/ui/useEscapeKey'
import { useNumberedShortcuts, useShortcut, type RegistrableShortcut } from '../src/ui/useShortcut'

// `mock`-prefixed, which is the only way a `jest.mock` factory may reach out of scope.
const mockListeners = new Set<(action: string) => void>()
let mockSubscriptions = 0

jest.mock('../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (action: string) => void) => {
    mockSubscriptions += 1
    mockListeners.add(handler)

    return () => {
      mockSubscriptions -= 1
      mockListeners.delete(handler)
    }
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: () => () => {}
}))

function press(action: ShortcutAction) {
  act(() => {
    for (const listener of [...mockListeners]) {
      listener(action)
    }
  })
}

beforeEach(() => {
  mockListeners.clear()
  mockSubscriptions = 0
})

function Taker({
  action,
  enabled = true,
  onFire
}: {
  action: RegistrableShortcut
  enabled?: boolean
  onFire: () => void
}) {
  useShortcut(action, onFire, enabled)

  return <Text>{action}</Text>
}

describe('useShortcut', () => {
  it('holds one native subscription however many screens register', () => {
    const view = render(
      <>
        <Taker action="search" onFire={jest.fn()} />
        <Taker action="settings" onFire={jest.fn()} />
        <Taker action="nextChat" onFire={jest.fn()} />
      </>
    )

    expect(mockSubscriptions).toBe(1)

    view.unmount()
    expect(mockSubscriptions).toBe(0)
  })

  it('delivers to whoever registered that action LAST', () => {
    const first = jest.fn()
    const second = jest.fn()

    render(
      <>
        <Taker action="search" onFire={first} />
        <Taker action="search" onFire={second} />
      </>
    )

    press('search')

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('hands the action back when the thing that took it goes away', () => {
    const list = jest.fn()
    const sheet = jest.fn()

    const view = render(
      <>
        <Taker action="search" onFire={list} />
        <Taker action="search" onFire={sheet} />
      </>
    )

    view.rerender(<Taker action="search" onFire={list} />)
    press('search')

    expect(list).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()
  })

  it('keeps the actions apart: one screen’s ⌘K is not another screen’s ⌘,', () => {
    const search = jest.fn()
    const settings = jest.fn()

    render(
      <>
        <Taker action="search" onFire={search} />
        <Taker action="settings" onFire={settings} />
      </>
    )

    press('search')

    expect(search).toHaveBeenCalledTimes(1)
    expect(settings).not.toHaveBeenCalled()
  })

  it('does not fire for a screen that is registered but disabled', () => {
    const hidden = jest.fn()

    render(<Taker action="search" enabled={false} onFire={hidden} />)
    press('search')

    expect(hidden).not.toHaveBeenCalled()
  })
})

describe('⌘1…9', () => {
  it('counts from one on the keyboard and from zero in the list', () => {
    const open = jest.fn()

    function Numbered() {
      useNumberedShortcuts(open)

      return <Text>numbered</Text>
    }

    render(<Numbered />)

    press('chat1')
    press('chat9')

    expect(open.mock.calls).toEqual([[0], [8]])
  })
})

describe('⌘W', () => {
  it('closes one level through the Escape stack rather than a stack of its own', () => {
    const closeSheet = jest.fn()
    const closePanel = jest.fn()

    function EscapeTaker({ onEscape }: { onEscape: () => void }) {
      useEscapeKey(onEscape)

      return <Text>taker</Text>
    }

    render(
      <>
        {/* Something has to hold a shortcut subscription open for the event to arrive. */}
        <Taker action="search" onFire={jest.fn()} />
        <EscapeTaker onEscape={closePanel} />
        <EscapeTaker onEscape={closeSheet} />
      </>
    )

    press('close')

    // The thing that opened last, exactly as Escape would.
    expect(closeSheet).toHaveBeenCalledTimes(1)
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('does nothing at all when there is no level to close', () => {
    render(<Taker action="search" onFire={jest.fn()} />)

    // A ⌘W on a bare chat list is a no-op rather than a crash or a closed window:
    // the standard Close item is removed from the Mac's menu bar, so this really is
    // where the keystroke ends.
    expect(() => press('close')).not.toThrow()
  })
})
