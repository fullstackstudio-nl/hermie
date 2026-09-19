/**
 * The composer: send, stop, the slash popover, and the attachment tray.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { Composer } from '../../src/chat-ui'
import {
  COMPOSER_FIELD_INSET,
  COMPOSER_FIELD_RADIUS,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_ROUND_SIZE
} from '../../src/chat-ui/Composer'
import { renderScreen } from '../support/render'

const mockEscapeListeners = new Set<() => void>()
let mockShiftDown = false

jest.mock('../../src/platform/keyboard-modifiers', () => ({
  isShiftDown: () => mockShiftDown,
  hasHardwareKeyboard: () => false,
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  mockShiftDown = false
})

/** The resolved style of a rendered node, function styles included. */
function styleOf(testID: string): Record<string, number> {
  const raw = screen.getByTestId(testID).props.style as unknown

  return StyleSheet.flatten(typeof raw === 'function' ? (raw as () => unknown)({ pressed: false }) : raw) as Record<
    string,
    number
  >
}

const SUGGESTIONS = [
  { description: 'Compact the conversation', name: 'compact' },
  { description: 'Show the current model', name: 'model' }
]

function renderComposer(props: Record<string, unknown> = {}) {
  const handlers = {
    onAttach: jest.fn(),
    onAttachFile: jest.fn(),
    onChangeText: jest.fn(),
    onQuerySlash: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onSend: jest.fn(),
    onStop: jest.fn()
  }

  renderScreen(<Composer value="" {...handlers} {...props} />)

  return handlers
}

describe('Composer', () => {
  it('reports typing to the owner of the draft', () => {
    const handlers = renderComposer()

    fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello')
    expect(handlers.onChangeText).toHaveBeenCalledWith('Hello')
  })

  it('cannot send an empty draft', () => {
    const handlers = renderComposer()

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('sends the draft it was given', () => {
    const handlers = renderComposer({ value: 'Check the release notes' })

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('Check the release notes')
  })

  it('turns into a stop button while a turn runs', () => {
    const handlers = renderComposer({ running: true, value: 'ignored' })

    expect(screen.queryByTestId('composer-send')).toBeNull()

    fireEvent.press(screen.getByTestId('composer-stop'))
    expect(handlers.onStop).toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('can stop with an empty draft', () => {
    const handlers = renderComposer({ running: true })

    fireEvent.press(screen.getByTestId('composer-stop'))
    expect(handlers.onStop).toHaveBeenCalled()
  })

  it('asks for slash candidates and shows the popover', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/co' })

    expect(handlers.onQuerySlash).toHaveBeenCalledWith('co')
    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
    expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
  })

  it('writes the picked command back into the draft', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/' })

    fireEvent.press(screen.getByTestId('slash-option-model'))
    expect(handlers.onChangeText).toHaveBeenCalledWith('/model ')
  })

  it('leaves a mid-sentence slash alone', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: 'see src/app' })

    expect(handlers.onQuerySlash).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
  })

  it('offers attachments and can remove one', () => {
    const handlers = renderComposer({
      attachments: [{ id: 'att-1', kind: 'image', name: 'diagram.png', uri: 'file:///tmp/diagram.png' }]
    })

    expect(screen.getByTestId('composer-attachments')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attachment-remove-att-1'))
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('att-1')

    // The "+" opens the MENU now; the picker is the menu's first entry. Nothing
    // asynchronous happens between the tap and the menu, which is the point.
    fireEvent.press(screen.getByTestId('composer-attach'))
    expect(handlers.onAttach).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))
    expect(handlers.onAttach).toHaveBeenCalled()
  })

  it('offers Choose file as the menu\u2019s own entry, not a long press', () => {
    const handlers = renderComposer()

    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-file'))

    expect(handlers.onAttachFile).toHaveBeenCalled()
  })

  it('marks the chosen entry busy and refuses a second tap on it', () => {
    // The busy mark is the only feedback there is during the 1.5-2s the system
    // picker takes to come up on a Mac, and a second tap during it would present
    // two pickers.
    const handlers = renderComposer({ attachBusy: 'file' })

    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(screen.getByTestId('composer-attach-menu-file-busy')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attach-menu-file'))
    expect(handlers.onAttachFile).not.toHaveBeenCalled()

    // The other entry is still usable: only the one that is waiting is blocked.
    expect(screen.queryByTestId('composer-attach-menu-photo-busy')).toBeNull()
  })

  it('shows a file as a chip with its size, and an image as a thumbnail', () => {
    renderComposer({
      attachments: [
        { id: 'att-1', kind: 'image', name: 'diagram.png', uri: 'file:///tmp/diagram.png' },
        { id: 'att-2', kind: 'file', name: 'quarterly-report-final-v4.xlsx', size: 48210, status: 'uploaded' }
      ]
    })

    expect(screen.getByTestId('composer-attachment-att-2')).toBeTruthy()
    expect(screen.getByText('47 KB')).toBeTruthy()
  })

  it('says why a rejected file will not be sent', () => {
    renderComposer({
      attachments: [
        { error: 'Too large · 100 MB max', id: 'att-3', kind: 'file', name: 'capture.mov', status: 'error' }
      ]
    })

    expect(screen.getByText('Too large · 100 MB max')).toBeTruthy()
  })

  it('can send an attachment with no text', () => {
    const handlers = renderComposer({ attachments: [{ id: 'att-1', kind: 'image', name: 'diagram.png' }] })

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('')
  })

  it('shows the prompt the backend parked behind the running turn', () => {
    renderComposer({ queuedText: 'Include source links' })

    expect(screen.getByTestId('composer-queued')).toBeTruthy()
    expect(screen.getByText(/Include source links/)).toBeTruthy()
  })

  it('announces the disabled "+" as disabled rather than only dimming it', () => {
    renderScreen(<Composer onChangeText={jest.fn()} onSend={jest.fn()} value="" />)

    expect(screen.getByTestId('composer-attach').props.accessibilityState).toMatchObject({ disabled: true })
  })

  it('offers only the pickers the caller actually gave it', () => {
    renderScreen(<Composer onAttachFile={jest.fn()} onChangeText={jest.fn()} onSend={jest.fn()} value="" />)

    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(screen.getByTestId('composer-attach-menu-file')).toBeTruthy()
    expect(screen.queryByTestId('composer-attach-menu-photo')).toBeNull()
  })
})

/**
 * The geometry of the composer row.
 *
 * Sebas saw the send button poking through the top of the field's border and
 * sitting off-centre, because all three controls sized themselves independently
 * inside one 28pt corner radius. The first fix was arithmetic: make the three
 * agree on one line box and assert the inequality that made overflow impossible.
 *
 * The mockup's answer is better than the arithmetic. The buttons are **not inside
 * the field at all** — a separate round "+", a pill field, a separate round send —
 * so a button cannot overflow a field it is not in, at any text size, in either
 * theme. These assertions therefore pin the new structure AND keep the old
 * concern: the field stays a true pill at one line and keeps the same caps as it
 * grows, and the two round controls stay round, equal and whole-numbered (the Mac
 * renders this build scaled, so a fractional control size is a visible sliver).
 */
describe('the composer row', () => {
  it('keeps the buttons outside the field, so neither can overflow it', () => {
    renderComposer({ value: 'ready' })

    const field = styleOf('composer-field')

    // Half the single-line height: a true pill at one line, and the same caps
    // once it grows. A larger radius turns a tall field's ends into full
    // semicircles; 28pt on a 40pt box was the original bug.
    expect(field.borderRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(COMPOSER_FIELD_RADIUS).toBe((COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2)

    // The "+" and the send are siblings of the field, not children of it: the
    // field's own testID is not an ancestor of either.
    expect(screen.getByTestId('composer-attach')).toBeTruthy()
    expect(screen.getByTestId('composer-send')).toBeTruthy()
    expect(screen.queryByTestId('composer-field')?.findAllByProps({ testID: 'composer-send' })).toHaveLength(0)
  })

  it('draws both round controls at one whole-numbered size', () => {
    renderComposer({ value: 'ready' })

    const circle = styleOf('composer-send-circle')

    expect(COMPOSER_ROUND_SIZE).toBe(Math.round(COMPOSER_ROUND_SIZE))
    expect(styleOf('composer-send').height).toBe(COMPOSER_ROUND_SIZE)
    expect(styleOf('composer-attach').height).toBe(COMPOSER_ROUND_SIZE)
    expect(circle.height).toBe(COMPOSER_ROUND_SIZE)
    expect(circle.width).toBe(circle.height)
    expect(circle.borderRadius).toBe(COMPOSER_ROUND_SIZE / 2)
  })

  it('anchors the row to the bottom so a growing input pushes upward', () => {
    renderComposer({ value: 'one\ntwo\nthree\nfour' })

    // The input is the only thing allowed to grow; the round controls ride the
    // bottom line rather than stretching with it.
    expect(styleOf('composer-input').minHeight).toBe(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-input').maxHeight).toBeGreaterThan(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-send').height).toBe(COMPOSER_ROUND_SIZE)
  })

  it('keeps the stop button on exactly the same geometry', () => {
    renderComposer({ running: true, value: 'ignored' })

    expect(styleOf('composer-stop').height).toBe(COMPOSER_ROUND_SIZE)
    expect(styleOf('composer-send-circle').height).toBe(COMPOSER_ROUND_SIZE)
  })
})

/**
 * The keyboard path, which is the only way to send on a Mac.
 *
 * Two mechanisms, and which one fires is decided by `submitBehavior`. Where a
 * bare Return sends, iOS suppresses the newline and calls `onSubmitEditing`
 * instead, and `onKeyPress` never sees the key at all — that is what makes a
 * double send structurally impossible rather than guarded against.
 *
 * The rule both enforce: Return SENDS, or does nothing. It used to fall through
 * to the same handler as the round button, so while a reply was streaming the
 * send key cancelled the turn — typing the next message and pressing Return
 * killed the answer being written. A prompt sent mid-turn is parked by the
 * gateway; stopping is the button's job, and Escape's.
 */
describe('the Composer keyboard', () => {
  const submitEditing = () => fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

  const keyPress = (key: string, extra: Record<string, unknown> = {}) =>
    fireEvent(screen.getByTestId('composer-input'), 'keyPress', { nativeEvent: { key, ...extra } })

  it('asks the platform to submit on Return where a hardware keyboard is certain', () => {
    renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    expect(screen.getByTestId('composer-input').props.submitBehavior).toBe('submit')
  })

  it('leaves Return as the newline everywhere else', () => {
    renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    expect(screen.getByTestId('composer-input').props.submitBehavior).toBe('newline')
  })

  it('sends on the Return the platform turned into a submit', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    submitEditing()
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  it('does not stop a running turn on Return', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: 'the next message' })

    submitEditing()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('the next message')
  })

  it('does nothing at all on Return with nothing to send', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: '' })

    submitEditing()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('leaves a bare Enter alone where it is the newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'first line' })

    keyPress('Enter')
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter as the newline where the flag arrives', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'first line' })

    keyPress('Enter', { shiftKey: true })
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('sends on Cmd+Enter even where a bare Enter is a newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    keyPress('Enter', { metaKey: true })
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })
})

/**
 * Shift+Return is a newline, and it has to be inserted by hand.
 *
 * `submitBehavior="submit"` tells iOS not to insert one, which is what makes a
 * bare Return the send key — and it applies to Shift+Return too, because a text
 * field's key event carries no modifier state on iOS and both arrive as the same
 * `"\n"`. So the composer asks the keyboard which chord it was and, for Shift,
 * writes the newline into the draft itself at the caret.
 */
describe('the Composer and Shift+Return', () => {
  const submitEditing = () => fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

  const moveCaret = (start: number, end: number = start) =>
    fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
      nativeEvent: { selection: { start, end } }
    })

  it('sends when Shift is up', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    submitEditing()

    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
    expect(handlers.onChangeText).not.toHaveBeenCalled()
  })

  it('inserts a newline at the end when Shift is down, and does not send', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'first line' })

    moveCaret('first line'.length)
    submitEditing()

    expect(handlers.onSend).not.toHaveBeenCalled()
    expect(handlers.onChangeText).toHaveBeenCalledWith('first line\n')
  })

  it('inserts at the caret, not at the end', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'one two' })

    moveCaret(3)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('one\n two')
  })

  it('replaces a selected range, the way any other character would', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'keep DROP keep' })

    moveCaret(5, 9)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('keep \n keep')
  })

  it('leaves the caret after the newline it just inserted', () => {
    mockShiftDown = true
    renderComposer({ hardwareKeyboard: true, value: 'one two' })

    moveCaret(3)
    submitEditing()

    expect(screen.getByTestId('composer-input').props.selection).toEqual({ start: 4, end: 4 })
  })

  it('survives a stale caret past the end of the draft', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'short' })

    moveCaret(99, 120)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('short\n')
  })

  it('ignores Shift where a bare Return is already the newline', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    submitEditing()

    // `submitBehavior` is 'newline' there, so the platform inserts it and this
    // handler is not the one that runs — but if it does, it must not double up.
    expect(handlers.onChangeText).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  it('shows the two chords under the field only where Return sends', () => {
    renderComposer({ hardwareKeyboard: true })
    expect(screen.getByTestId('composer-key-hint')).toBeTruthy()

    renderComposer({ hardwareKeyboard: false })
    expect(screen.queryByTestId('composer-key-hint')).toBeNull()
  })
})

/** Escape stops a running turn, and yields to the slash popover while it is open. */
describe('the Composer and Escape', () => {
  const pressEscape = () =>
    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

  it('stops a running turn', () => {
    const handlers = renderComposer({ running: true, value: 'ignored' })

    pressEscape()

    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no turn is running', () => {
    const handlers = renderComposer({ value: 'idle' })

    pressEscape()

    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('closes the slash popover first, and leaves the turn running', () => {
    const handlers = renderComposer({ running: true, suggestions: SUGGESTIONS, value: '/' })

    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()

    pressEscape()

    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
    // The draft is untouched: dismissing the list is not deleting the slash.
    expect(handlers.onChangeText).not.toHaveBeenCalled()

    // With the popover gone the turn is next in line.
    pressEscape()
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })
})
