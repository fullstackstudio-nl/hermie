/**
 * The composer: send, stop, the slash popover, and the attachment tray.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { Composer } from '../../src/chat-ui'
import { renderScreen } from '../support/render'

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
})
