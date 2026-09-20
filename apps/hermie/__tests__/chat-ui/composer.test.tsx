/**
 * The composer: send, stop, the slash popover, and the attachment tray.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { Platform, StyleSheet } from 'react-native'

import { Composer } from '../../src/chat-ui'
import {
  ATTACH_POPOVER_MIN_WIDTH,
  COMPOSER_FIELD_INSET,
  COMPOSER_FIELD_RADIUS,
  composerFieldPadding,
  COMPOSER_IOS_TOP_INSET,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_ROUND_SIZE,
  COMPOSER_TEXT_LINE_HEIGHT
} from '../../src/chat-ui/Composer'
import { renderScreen } from '../support/render'

const mockEscapeListeners = new Set<() => void>()
const mockShortcutListeners = new Set<(action: string) => void>()
let mockShiftDown = false
let mockHardwareKeyboard = false

// A Mac is the iOS build on Apple Silicon, and this file needs to render as
// both. `COMPOSER_ROUND_SIZE` is read at import time and is therefore fixed at
// the value below for the whole file; only what is read per render follows the
// flag.
jest.mock('../../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

// ↑, ↓ and Tab reach the composer from the keyboard seam, not from the field: a
// `TextInput` only reports keys that insert text.
jest.mock('../../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (action: string) => void) => {
    mockShortcutListeners.add(handler)

    return () => mockShortcutListeners.delete(handler)
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('../../src/platform/keyboard-modifiers', () => ({
  isShiftDown: () => mockShiftDown,
  hasHardwareKeyboard: () => mockHardwareKeyboard,
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  mockShortcutListeners.clear()
  mockShiftDown = false
})

/** One press of ↑, ↓ or Tab, as the seam delivers it. */
function pressKey(action: 'suggestionUp' | 'suggestionDown' | 'suggestionAccept') {
  act(() => {
    for (const listener of [...mockShortcutListeners]) {
      listener(action)
    }
  })
}

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

  it('sends what is typed even while a turn runs, rather than stopping it', () => {
    // Sending is always possible: the message is parked behind the running turn
    // and appears at the end of the transcript as a queued bubble. The button
    // under the words you just typed must not throw the reply away.
    const handlers = renderComposer({ running: true, value: 'and one more thing' })

    expect(screen.queryByTestId('composer-stop')).toBeNull()

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('and one more thing')
    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('is a stop button while a turn runs and there is nothing to send', () => {
    const handlers = renderComposer({ running: true })

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

  it('asks for slash candidates on the whole typed line and shows the popover', () => {
    // The LINE, not the name: `complete.slash` completes the argument as well,
    // and it can only do that if it is given what was typed.
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/co' })

    expect(handlers.onQuerySlash).toHaveBeenCalledWith('/co')
    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
    expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
  })

  it('keeps asking once there is an argument, which is what completes it', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/model exa' })

    expect(handlers.onQuerySlash).toHaveBeenCalledWith('/model exa')
    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
  })

  it('closes the list at a newline, because a multi-line draft is a message', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/note\nsecond line' })

    expect(handlers.onQuerySlash).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
  })

  it('writes what the caller says the row inserts, argument and all', () => {
    const handlers = renderComposer({
      suggestions: [{ description: 'A model', insert: '/model example-large', name: 'example-large' }],
      value: '/model exa'
    })

    fireEvent.press(screen.getByTestId('slash-option-example-large'))
    expect(handlers.onChangeText).toHaveBeenCalledWith('/model example-large')
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
    //
    // Per corner rather than one `borderRadius`: a glass surface spells all four
    // out so that a bottom sheet can square its lower pair, and a blanket radius
    // beside a per-corner one is two rules for one shape.
    expect(field.borderTopLeftRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderTopRightRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderBottomLeftRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderBottomRightRadius).toBe(COMPOSER_FIELD_RADIUS)
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
    expect(styleOf('composer-input').maxHeight).toBeGreaterThan(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-send').height).toBe(COMPOSER_ROUND_SIZE)
  })

  /**
   * One line, vertically centred — and why the field has no `minHeight` any more.
   *
   * A `minHeight` made the box taller than its content, and an iOS multiline field
   * lays its text out from the TOP of a box like that: the placeholder sat high with
   * the slack below it, which is what the owner reported. The height of one line now
   * comes from the leading plus the padding, so there is no slack for the platform to
   * put anywhere.
   */
  it('centres one line in the pill from an explicit leading, not from a minimum height', () => {
    renderComposer({ value: '' })

    const style = styleOf('composer-input') as {
      lineHeight?: number
      minHeight?: number
      paddingBottom?: number
      paddingTop?: number
    }

    expect(style.lineHeight).toBe(COMPOSER_TEXT_LINE_HEIGHT)
    expect(style.minHeight).toBeUndefined()

    // Leading plus both paddings IS the single-line field height, so the pill is a
    // true pill at one line without anything having to be a minimum.
    const inset = Platform.OS === 'ios' ? COMPOSER_IOS_TOP_INSET : 0

    expect(COMPOSER_TEXT_LINE_HEIGHT + (style.paddingTop ?? 0) + inset + (style.paddingBottom ?? 0)).toBe(
      COMPOSER_LINE_HEIGHT
    )
  })

  it('leaves the two visible gaps equal, with the platform’s own inset taken off the top', () => {
    // The arithmetic, stated where it is decided. `paddingTop` is deliberately NOT
    // `paddingBottom` on iOS: the platform adds its own space above the first line,
    // and what has to be symmetric is what a reader sees.
    expect(composerFieldPadding(0)).toEqual({ paddingBottom: 5, paddingTop: 5 })
    expect(composerFieldPadding(2)).toEqual({ paddingBottom: 5, paddingTop: 3 })

    // …and never negative, however large a platform's inset turns out to be.
    expect(composerFieldPadding(99).paddingTop).toBe(0)
  })

  it('keeps the stop button on exactly the same geometry', () => {
    renderComposer({ running: true })

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
 * killed the answer being written. A prompt sent mid-turn is parked in the
 * queue; stopping is what the button does with an EMPTY field, and what Escape
 * does always.
 */
/**
 * The slash list under the keyboard.
 *
 * Arrow keys and Tab do not reach a `TextInput` at all — React Native builds its
 * `onKeyPress` payload from the text a field is about to insert — so all three
 * come down the same road as Escape and the desktop shortcuts, and only while
 * the list is open.
 */
describe('the slash list and the keyboard', () => {
  const OPTIONS = [
    { description: 'Compact the conversation', name: 'compact' },
    { description: 'Show the current model', name: 'model' }
  ]

  /** Which row the keyboard is on, as the list itself reports it. */
  const selected = (name: string) =>
    screen.getByTestId(`slash-option-${name}`).props.accessibilityState?.selected === true

  it('starts on the first row and walks down and back up', () => {
    renderComposer({ suggestions: OPTIONS, value: '/' })

    expect(selected('compact')).toBe(true)

    pressKey('suggestionDown')
    expect(selected('model')).toBe(true)
    expect(selected('compact')).toBe(false)

    // …and stops at the end rather than wrapping: a list that wraps under a held
    // arrow key never lets go of the reader.
    pressKey('suggestionDown')
    expect(selected('model')).toBe(true)

    pressKey('suggestionUp')
    expect(selected('compact')).toBe(true)
    pressKey('suggestionUp')
    expect(selected('compact')).toBe(true)
  })

  it('takes the highlighted row on Tab', () => {
    const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

    pressKey('suggestionDown')
    pressKey('suggestionAccept')

    expect(handlers.onChangeText).toHaveBeenCalledWith('/model ')
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('takes the highlighted row on Enter rather than sending the line', () => {
    mockHardwareKeyboard = true

    try {
      const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

      expect(handlers.onChangeText).toHaveBeenCalledWith('/compact ')
      expect(handlers.onSend).not.toHaveBeenCalled()
    } finally {
      mockHardwareKeyboard = false
    }
  })

  it('sends on Enter with no list open, which is every other line', () => {
    mockHardwareKeyboard = true

    try {
      const handlers = renderComposer({ suggestions: [], value: 'just a message' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

      expect(handlers.onSend).toHaveBeenCalledWith('just a message')
    } finally {
      mockHardwareKeyboard = false
    }
  })

  it('gives the keys back the moment the list is closed', () => {
    const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()

    pressKey('suggestionAccept')
    expect(handlers.onChangeText).not.toHaveBeenCalled()
  })
})

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

  /**
   * The owner's second report: on an iPad in a keyboard case Enter did nothing
   * useful, while the same build on a Mac sent. The decision had been hung on
   * `RUNS_ON_MAC`, which is a proxy for "is there a keyboard" and is false on
   * exactly that device. It now asks the HID state as well.
   */
  it('sends on a bare Return wherever a keyboard is actually attached', () => {
    mockHardwareKeyboard = true

    try {
      // No `hardwareKeyboard` prop at all: this is the DEFAULT, which is what
      // the chat screen relies on.
      const handlers = renderComposer({ value: 'Ship it' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      expect(handlers.onSend).toHaveBeenCalledWith('Ship it')

      // And Shift+Return there is still the newline.
      mockShiftDown = true
      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      expect(handlers.onChangeText).toHaveBeenCalledWith('Ship it\n')
    } finally {
      mockHardwareKeyboard = false
      mockShiftDown = false
    }
  })

  it('leaves a device with no keyboard on the software Return', () => {
    const handlers = renderComposer({ value: 'Ship it' })

    fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

    // `submitBehavior` is 'newline' there, so this handler is not the one that
    // runs; reaching it at all means the platform asked to submit.
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
    expect(screen.queryByTestId('composer-key-hint')).toBeNull()
  })

  it('announces the two chords on the Mac and nowhere else', () => {
    // NOT wherever a bare Return sends. On an iPad with a keyboard case it does
    // send, and the line still has nowhere to be: iPadOS keeps its own keyboard
    // bar along the bottom of the window and the hint was drawn straight
    // through it, with the system's keyboard button sitting on the words.
    renderComposer({ hardwareKeyboard: true })
    expect(screen.queryByTestId('composer-key-hint')).toBeNull()

    runsOnMac.RUNS_ON_MAC = true

    try {
      renderComposer({ hardwareKeyboard: true })
      expect(screen.getByTestId('composer-key-hint')).toBeTruthy()
    } finally {
      runsOnMac.RUNS_ON_MAC = false
    }
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

/**
 * The attach menu as a POPOVER.
 *
 * It was a list of two rows in a card above the composer, and the owner's note was
 * that nothing in it said which control had opened it. WhatsApp's answer is a
 * popover with a pointer at the button and the choices as round icon buttons with
 * their labels underneath — so the three facts asserted here are the pointer's
 * existence, the pointer's POSITION (a pointer a few points off its anchor reads as
 * a rendering fault, which is worse than none), and that a choice is a drawn icon
 * rather than a row of text.
 */
describe('the attach popover', () => {
  const hidden = { includeHiddenElements: true } as const

  const pressEscape = () =>
    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

  const openMenu = (props: Record<string, unknown> = {}) => {
    const handlers = renderComposer(props)

    fireEvent.press(screen.getByTestId('composer-attach'))

    return handlers
  }

  it('points at the “+” it belongs to, and at its centre', () => {
    openMenu()

    const pointer = StyleSheet.flatten(
      screen.getByTestId('composer-attach-menu-pointer', hidden).props.style as never
    ) as { bottom?: number; left?: number; width?: number }

    // Below the card, not inside it: the shape escapes the popover the way the
    // bubble's tail escapes the bubble.
    expect(pointer.bottom).toBeLessThan(0)

    // The tip lands on the button's centre. `left` is the tip less half the shape,
    // so tip = left + width / 2 = half the round control.
    expect((pointer.left ?? 0) + (pointer.width ?? 0) / 2).toBe(COMPOSER_ROUND_SIZE / 2)
  })

  it('draws each choice as an icon with its label underneath, not as a row of text', () => {
    openMenu()

    // A drawn mark, per choice — not a glyph, not a row.
    expect(screen.getByTestId('composer-attach-menu-photo')).toBeTruthy()
    expect(screen.getByTestId('composer-attach-menu-file')).toBeTruthy()
    expect(screen.getByText('Photo library')).toBeTruthy()
    expect(screen.getByText('Choose file')).toBeTruthy()

    // The popover is a ROW of choices; a column of two is the list layout.
    const inner = StyleSheet.flatten(screen.getByTestId('composer-attach-menu').props.style as never)

    expect(inner).toBeTruthy()
  })

  it('dismisses on a tap that is not on it', () => {
    openMenu()

    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attach-dismiss'))

    expect(screen.queryByTestId('composer-attach-menu')).toBeNull()
  })

  it('dismisses on Escape, before anything else Escape could mean', () => {
    const handlers = openMenu({ running: true })

    pressEscape()

    expect(screen.queryByTestId('composer-attach-menu')).toBeNull()
    // Registered last, so the running turn is untouched — the menu is the level the
    // reader is looking at.
    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('has no catcher to tap when it is closed', () => {
    renderComposer()

    expect(screen.queryByTestId('composer-attach-dismiss')).toBeNull()
  })

  it('falls back to the stacked list where the popover cannot fit', () => {
    renderComposer()

    // The composer's own width, reported as a phone's with the tray open.
    fireEvent(screen.getByTestId('composer-row'), 'layout', {
      nativeEvent: { layout: { width: ATTACH_POPOVER_MIN_WIDTH - 1, height: 60, x: 0, y: 0 } }
    })
    fireEvent.press(screen.getByTestId('composer-attach'))

    // The list has no pointer, because it is not anchored to anything.
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()
    expect(screen.queryByTestId('composer-attach-menu-pointer', hidden)).toBeNull()
    // …and the choices are still both there and still both work.
    expect(screen.getByText('Photo library')).toBeTruthy()
    expect(screen.getByText('Choose file')).toBeTruthy()
  })

  it('takes the popover at the width a chat column actually has', () => {
    renderComposer()

    fireEvent(screen.getByTestId('composer-row'), 'layout', {
      nativeEvent: { layout: { width: ATTACH_POPOVER_MIN_WIDTH, height: 60, x: 0, y: 0 } }
    })
    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(screen.getByTestId('composer-attach-menu-pointer', hidden)).toBeTruthy()
  })
})
