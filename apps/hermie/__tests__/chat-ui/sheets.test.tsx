/**
 * The bottom sheets, and the three rules that matter more than their looks:
 * a tap guard, exactly the server's choices, and a backdrop that answers
 * nothing while a question is open.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { Text } from 'react-native'

import { approvalItem, clarifyItem } from '../../src/chat-ui/fixtures'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../src/ui/sheets'
import { renderScreen } from '../support/render'

const MODEL_OPTIONS = [
  { label: 'Gateway default', value: 'default' },
  { expensive: true, label: 'example-model-large', value: 'example-model-large' }
]

const REASONING_OPTIONS = [
  { label: 'High', value: 'high' },
  { label: 'Low', value: 'low' }
]

describe('BottomSheet', () => {
  it('dismisses on a backdrop tap', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    fireEvent.press(screen.getByTestId('sheet-backdrop'))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('ignores the backdrop while blocking', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet blocking onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    fireEvent.press(screen.getByTestId('sheet-backdrop'))
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('renders nothing while closed', () => {
    const view = renderScreen(
      <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible={false}>
        <Text>Body</Text>
      </BottomSheet>
    )

    expect(view.queryByTestId('sheet')).toBeNull()
  })
})

describe('ApprovalSheet', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const renderSheet = (props: Record<string, unknown> = {}) => {
    const onRespond = jest.fn()

    const view = renderScreen(
      <ApprovalSheet
        botHandle="researcher"
        item={approvalItem}
        onClose={jest.fn()}
        onRespond={onRespond}
        visible
        {...props}
      />
    )

    return { onRespond, view }
  }

  it('renders exactly the server choices, in the server order', () => {
    renderSheet()

    expect(screen.getByTestId('approval-choice-allow')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-allow_session')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-allow_permanent')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-deny')).toBeTruthy()
  })

  it('offers no choice the server did not send', () => {
    renderSheet({ item: { ...approvalItem, choices: ['allow', 'deny'] } })

    expect(screen.queryByTestId('approval-choice-allow_permanent')).toBeNull()
    expect(screen.queryByTestId('approval-choice-allow_session')).toBeNull()
  })

  it('ignores a tap inside the guard window and accepts one after it', () => {
    const { onRespond } = renderSheet()

    fireEvent.press(screen.getByTestId('approval-choice-allow'))
    expect(onRespond).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(400)
    })

    fireEvent.press(screen.getByTestId('approval-choice-allow'))
    expect(onRespond).toHaveBeenCalledWith('allow')
  })

  it('passes the choice through verbatim', () => {
    const { onRespond } = renderSheet({ tapGuardMs: 0 })

    fireEvent.press(screen.getByTestId('approval-choice-allow_permanent'))
    expect(onRespond).toHaveBeenCalledWith('allow_permanent')
  })

  it('shows the command and the tool that asked', () => {
    renderSheet()

    expect(screen.getByTestId('approval-command').props.children).toBe(approvalItem.command)
    expect(screen.getByTestId('approval-tool-name')).toBeTruthy()
  })

  it('explains a request answered somewhere else', () => {
    renderSheet({ item: { ...approvalItem, cancelReason: 'resolved', state: 'cancelled' } })

    expect(screen.getByText('Answered elsewhere')).toBeTruthy()
    expect(screen.queryByTestId('approval-choice-allow')).toBeNull()
  })

  it('explains a request that timed out', () => {
    renderSheet({ item: { ...approvalItem, cancelReason: 'timeout', state: 'cancelled' } })

    expect(screen.getByText('Timed out')).toBeTruthy()
  })

  it('reports the answer once it has one', () => {
    renderSheet({ item: { ...approvalItem, answer: 'allow', state: 'answered' } })

    expect(screen.getByText('Answered: Allow once')).toBeTruthy()
  })
})

describe('ClarifySheet', () => {
  const renderSheet = (props: Record<string, unknown> = {}) => {
    const onSubmit = jest.fn()
    const onLock = jest.fn()
    const onSkip = jest.fn()

    renderScreen(
      <ClarifySheet
        item={clarifyItem}
        onClose={jest.fn()}
        onLock={onLock}
        onSkip={onSkip}
        onSubmit={onSubmit}
        visible
        {...props}
      />
    )

    return { onLock, onSkip, onSubmit }
  }

  it('steps through a batch and submits every answer at once', () => {
    const { onSubmit } = renderSheet()

    expect(screen.getByTestId('clarify-step').props.children).toBe('Question 1 of 2')

    fireEvent.press(screen.getByTestId('clarify-choice-Warm and direct'))
    fireEvent.press(screen.getByTestId('clarify-next'))

    expect(screen.getByTestId('clarify-step').props.children).toBe('Question 2 of 2')

    // The second question is multi-select: both choices stay selected.
    fireEvent.press(screen.getByTestId('clarify-choice-Recovery'))
    fireEvent.press(screen.getByTestId('clarify-choice-Routines'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Warm and direct', q2: 'Recovery, Routines' })
  })

  it('locks one answer without submitting the batch', () => {
    const { onLock, onSubmit } = renderSheet()

    fireEvent.press(screen.getByTestId('clarify-choice-Formal'))
    fireEvent.press(screen.getByTestId('clarify-lock'))

    expect(onLock).toHaveBeenCalledWith('q1', 'Formal')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not offer to re-lock a question the server already accepted', () => {
    renderSheet({ item: { ...clarifyItem, answers: { q1: 'Formal' }, locked: ['q1'] } })

    expect(screen.queryByTestId('clarify-lock')).toBeNull()
    expect(screen.getByTestId('clarify-locked')).toBeTruthy()
  })

  it('skips', () => {
    const { onSkip } = renderSheet()

    fireEvent.press(screen.getByTestId('clarify-skip'))
    expect(onSkip).toHaveBeenCalled()
  })

  it('submits straight away for a single question', () => {
    const { onSubmit } = renderSheet({ item: { ...clarifyItem, questions: [clarifyItem.questions[0]] } })

    expect(screen.queryByTestId('clarify-step')).toBeNull()

    fireEvent.press(screen.getByTestId('clarify-choice-Playful'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Playful' })
  })
})

describe('ChatOptionsSheet', () => {
  const renderSheet = (props: Record<string, unknown> = {}) => {
    const handlers = {
      onChangeFast: jest.fn(),
      onChangeModel: jest.fn(),
      onChangeReasoningEffort: jest.fn(),
      onChangeShowBotToBot: jest.fn(),
      onChangeShowThinking: jest.fn(),
      onChangeVerbosity: jest.fn(),
      onChangeYolo: jest.fn(),
      onClose: jest.fn(),
      onConfirmExpensiveModel: jest.fn()
    }

    renderScreen(
      <ChatOptionsSheet
        botName="Researcher"
        fast
        model="default"
        modelOptions={MODEL_OPTIONS}
        reasoningEffort="high"
        reasoningOptions={REASONING_OPTIONS}
        showBotToBot
        showThinking={false}
        verbosity="normal"
        visible
        yolo={false}
        {...handlers}
        {...props}
      />
    )

    return handlers
  }

  it('reports switch and segment changes', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-yolo'))
    expect(handlers.onChangeYolo).toHaveBeenCalledWith(true)

    fireEvent.press(screen.getByTestId('option-verbosity-verbose'))
    expect(handlers.onChangeVerbosity).toHaveBeenCalledWith('verbose')

    fireEvent.press(screen.getByTestId('option-thinking'))
    expect(handlers.onChangeShowThinking).toHaveBeenCalledWith(true)
  })

  it('picks a reasoning effort from its own pane', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-reasoning'))
    fireEvent.press(screen.getByTestId('picker-option-low'))

    expect(handlers.onChangeReasoningEffort).toHaveBeenCalledWith('low')
  })

  it('routes an expensive model through the confirm callback', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-model'))
    fireEvent.press(screen.getByTestId('picker-option-example-model-large'))

    expect(handlers.onConfirmExpensiveModel).toHaveBeenCalledWith('example-model-large')
    expect(handlers.onChangeModel).not.toHaveBeenCalled()
  })

  it('filters the model list', () => {
    renderSheet()

    fireEvent.press(screen.getByTestId('option-model'))
    fireEvent.changeText(screen.getByTestId('picker-search'), 'large')

    expect(screen.queryByTestId('picker-option-default')).toBeNull()
    expect(screen.getByTestId('picker-option-example-model-large')).toBeTruthy()
  })
})
