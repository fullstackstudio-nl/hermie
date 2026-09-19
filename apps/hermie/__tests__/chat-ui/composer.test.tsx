/**
 * The composer: send, stop, the slash popover, and the attachment tray.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { Composer } from '../../src/chat-ui'
import {
  COMPOSER_BUTTON_SIZE,
  COMPOSER_FIELD_INSET,
  COMPOSER_FIELD_RADIUS,
  COMPOSER_LINE_HEIGHT
} from '../../src/chat-ui/Composer'
import { renderScreen } from '../support/render'

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
      attachments: [{ id: 'att-1', name: 'diagram.png', uri: 'file:///tmp/diagram.png' }]
    })

    expect(screen.getByTestId('composer-attachments')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attachment-remove-att-1'))
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('att-1')

    fireEvent.press(screen.getByTestId('composer-attach'))
    expect(handlers.onAttach).toHaveBeenCalled()
  })

  it('can send an attachment with no text', () => {
    const handlers = renderComposer({ attachments: [{ id: 'att-1', name: 'diagram.png' }] })

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
})

/**
 * The geometry of the rounded field.
 *
 * Sebas saw the send button poking through the top of the field's border and
 * sitting off-centre. Three things were sizing themselves independently inside
 * a 28pt corner radius — a 38pt circle, a 44pt "+" and a 40pt input in 3pt of
 * padding — so the row was as tall as its tallest child rather than as tall as
 * one line, and the circle sat in the corner's curve.
 *
 * These assertions are about the numbers rather than about pixels, because the
 * test renderer lays nothing out: what they pin down is the invariant that
 * makes overflow impossible, and the fact that every piece agrees on one line
 * box.
 */
describe('the Composer field', () => {
  it('keeps the button inside the field it sits in', () => {
    renderComposer({ value: 'ready' })

    const field = styleOf('composer-field')
    const circle = styleOf('composer-send-circle')

    // A circle, and never taller than the line box it is centred in — so the
    // field's inset is clearance on every side, in either theme.
    expect(circle.height).toBe(COMPOSER_BUTTON_SIZE)
    expect(circle.width).toBe(circle.height)
    expect(circle.borderRadius).toBe(COMPOSER_BUTTON_SIZE / 2)
    expect(COMPOSER_BUTTON_SIZE).toBeLessThanOrEqual(COMPOSER_LINE_HEIGHT)
    expect(field.padding).toBe(COMPOSER_FIELD_INSET)

    // Half the single-line height: a true pill at one line, and the same caps
    // once it grows. A larger radius turns a tall field's ends into full
    // semicircles and swallows the "+" on the bottom line.
    expect(field.borderRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(COMPOSER_FIELD_RADIUS).toBe((COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2)
  })

  it('gives the buttons and the input the same line box', () => {
    renderComposer({ value: 'ready' })

    // One line box: at a single line the buttons are centred in the field, and
    // as the input grows they stay on the bottom line rather than stretching
    // or floating.
    expect(styleOf('composer-send').height).toBe(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-attach').height).toBe(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-input').minHeight).toBe(COMPOSER_LINE_HEIGHT)
  })

  it('anchors the row to the bottom so a growing input pushes upward', () => {
    renderComposer({ value: 'one\ntwo\nthree\nfour' })

    expect(styleOf('composer-field').alignItems as unknown).toBe('flex-end')
    // The input is the only thing allowed to grow.
    expect(styleOf('composer-input').maxHeight).toBeGreaterThan(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-send').height).toBe(COMPOSER_LINE_HEIGHT)
  })

  it('keeps the stop button on exactly the same geometry', () => {
    renderComposer({ running: true, value: 'ignored' })

    expect(styleOf('composer-stop').height).toBe(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-send-circle').height).toBe(COMPOSER_BUTTON_SIZE)
  })
})

/**
 * The keyboard path, which is the only way to send on macOS.
 *
 * The rule it enforces: Enter SENDS, or does nothing. It used to fall through
 * to the same handler as the round button, so while a reply was streaming the
 * send key cancelled the turn — typing the next message and pressing Enter
 * killed the answer being written. A prompt sent mid-turn is parked by the
 * gateway; stopping is the button's job, and Escape's.
 */
describe('the Composer keyboard', () => {
  const enter = (extra: Record<string, unknown> = {}) =>
    fireEvent(screen.getByTestId('composer-input'), 'keyPress', { nativeEvent: { key: 'Enter', ...extra } })

  it('sends on a bare Enter where a hardware keyboard is certain', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    enter()
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  it('does not stop a running turn on Enter', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: 'the next message' })

    enter()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('the next message')
  })

  it('does nothing at all on Enter with nothing to send', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: '' })

    enter()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter as the newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'first line' })

    enter({ shiftKey: true })
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('sends on Cmd+Enter even where a bare Enter is a newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    enter()
    expect(handlers.onSend).not.toHaveBeenCalled()

    enter({ metaKey: true })
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  it('leaves Escape as the only key that stops a turn', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: 'ignored' })

    fireEvent(screen.getByTestId('composer-input'), 'keyPress', { nativeEvent: { key: 'Escape' } })
    expect(handlers.onStop).toHaveBeenCalled()
  })
})
