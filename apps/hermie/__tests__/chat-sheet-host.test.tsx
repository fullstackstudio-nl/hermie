/**
 * The one sheet a chat shows, and the order it shows things in.
 *
 * The bug this replaces was invisible in a screenshot: four sibling `Modal`s
 * each thought they were visible, iOS presented whichever asked first, and a
 * permission request that arrived while the options sheet was open simply
 * never appeared. So the assertions here are about SEQUENCE — what is on
 * screen, what replaces it, and what happens to a question after it has been
 * answered — rather than about how any one sheet looks.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { useState } from 'react'

import { ChatSheetHost, type RequestItem } from '../src/features/chats/ChatSheetHost'
import {
  initialSheetHostState,
  isSheetVisible,
  sheetHostReducer,
  targetSheet,
  type SheetHostState
} from '../src/features/chats/sheet-host'
import { approvalItem, clarifyItem, subagentTree } from '../src/chat-ui/fixtures'
import { renderScreen, withProviders } from './support/render'

describe('the sheet-host state machine', () => {
  it('ranks a waiting question above anything the reader opened', () => {
    expect(targetSheet('options', true)).toBe('request')
    expect(targetSheet('agents', true)).toBe('request')
    expect(targetSheet('agents', false)).toBe('agents')
    expect(targetSheet('none', false)).toBe('none')
  })

  it('opens straight away when nothing is on screen', () => {
    const next = sheetHostReducer(initialSheetHostState, { type: 'target', target: 'options' })

    expect(next).toEqual({ presented: 'options', target: 'options' })
    expect(isSheetVisible(next)).toBe(true)
  })

  it('closes the sheet that is up before it opens the next one', () => {
    const open: SheetHostState = { presented: 'options', target: 'options' }
    const swapping = sheetHostReducer(open, { type: 'target', target: 'request' })

    // Still mounted, no longer visible: this is the slide-out.
    expect(swapping).toEqual({ presented: 'options', target: 'request' })
    expect(isSheetVisible(swapping)).toBe(false)

    const settled = sheetHostReducer(swapping, { type: 'settled' })

    expect(settled).toEqual({ presented: 'request', target: 'request' })
    expect(isSheetVisible(settled)).toBe(true)
  })

  it('cancels a swap that changes its mind before the slide-out lands', () => {
    const swapping: SheetHostState = { presented: 'options', target: 'request' }
    const back = sheetHostReducer(swapping, { type: 'target', target: 'options' })

    expect(isSheetVisible(back)).toBe(true)
    expect(back.presented).toBe('options')
  })

  it('leaves nothing mounted once the last sheet has closed', () => {
    const closing = sheetHostReducer({ presented: 'request', target: 'request' }, { type: 'target', target: 'none' })

    expect(isSheetVisible(closing)).toBe(false)
    expect(sheetHostReducer(closing, { type: 'settled' })).toEqual({ presented: 'none', target: 'none' })
  })
})

const AGENTS = { tree: subagentTree }

const OPTIONS = {
  botName: 'Researcher',
  fast: false,
  model: 'example-model',
  modelOptions: [],
  onChangeFast: jest.fn(),
  onChangeModel: jest.fn(),
  onChangeReasoningEffort: jest.fn(),
  onChangeShowBotToBot: jest.fn(),
  onChangeShowThinking: jest.fn(),
  onChangeVerbosity: jest.fn(),
  onChangeYolo: jest.fn(),
  reasoningEffort: 'medium',
  reasoningOptions: [],
  showBotToBot: true,
  showThinking: true,
  verbosity: 'normal' as const,
  yolo: false
}

/**
 * A harness that owns the items the way the chat screen does: the host is told
 * which question is OPEN, and looks any question up by id — including one that
 * has stopped being open, which is the whole point of `findRequest`.
 */
function Harness({
  items,
  open,
  manual = 'none',
  onCloseRequest = jest.fn(),
  onRespondApproval = jest.fn(),
  onShowRequest,
  answeredDismissMs
}: {
  items: RequestItem[]
  open?: string
  manual?: 'none' | 'options' | 'agents'
  onCloseRequest?: (item: RequestItem) => void
  onRespondApproval?: (item: RequestItem, choice: string) => void
  onShowRequest?: (item: RequestItem) => void
  answeredDismissMs?: number
}) {
  const [sheet, setSheet] = useState(manual)

  return (
    <ChatSheetHost
      agents={AGENTS}
      botHandle="researcher"
      findRequest={id => items.find(item => item.id === id)}
      manual={sheet}
      onCloseManual={() => setSheet('none')}
      onCloseRequest={onCloseRequest}
      onLockClarify={jest.fn()}
      onRespondApproval={onRespondApproval}
      onSubmitClarify={jest.fn()}
      options={OPTIONS}
      tapGuardMs={0}
      {...(answeredDismissMs === undefined ? {} : { answeredDismissMs })}
      {...(onShowRequest ? { onShowRequest } : {})}
      {...(open ? { request: items.find(item => item.id === open) } : {})}
    />
  )
}

const renderHost = renderScreen

describe('ChatSheetHost', () => {
  it('presents a question that arrives while the options sheet is open', async () => {
    const view = renderHost(<Harness items={[approvalItem]} manual="options" />)

    expect(screen.getByTestId('chat-options-sheet')).toBeTruthy()
    expect(view.queryByTestId('approval-sheet')).toBeNull()

    // The question arrives. The options sheet has to go first, and the
    // approval takes its place once it has.
    view.rerender(withProviders(<Harness items={[approvalItem]} manual="options" open={approvalItem.id} />))

    await screen.findByTestId('approval-sheet')
    expect(view.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('never has two sheets mounted at once', () => {
    const view = renderHost(<Harness items={[clarifyItem]} manual="agents" open={clarifyItem.id} />)

    expect(view.queryByTestId('agents-sheet')).toBeNull()
    expect(screen.getByTestId('clarify-sheet')).toBeTruthy()
  })

  it('keeps an answered question on screen and says what happened to it', () => {
    const answered: RequestItem = { ...approvalItem, answer: 'once', state: 'answered' }

    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    expect(screen.getByTestId('approval-choice-once')).toBeTruthy()

    // The gateway resolves it: `chat.requests` no longer lists it at all.
    view.rerender(withProviders(<Harness items={[answered]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Answered: Allow once')
    expect(view.queryByTestId('approval-choice-once')).toBeNull()
  })

  it('says so when a question was answered somewhere else', () => {
    const elsewhere: RequestItem = { ...approvalItem, cancelReason: 'resolved', state: 'cancelled' }
    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    view.rerender(withProviders(<Harness items={[elsewhere]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Answered elsewhere')
  })

  it('says so when a question timed out', () => {
    const timedOut: RequestItem = { ...approvalItem, cancelReason: 'timeout', state: 'cancelled' }
    const view = renderHost(<Harness items={[approvalItem]} open={approvalItem.id} />)

    view.rerender(withProviders(<Harness items={[timedOut]} />))

    expect(screen.getByTestId('approval-resolution')).toHaveTextContent('Timed out')
  })

  it('closes itself a moment after the reader answers it here', () => {
    jest.useFakeTimers()

    try {
      const onCloseRequest = jest.fn()
      const answered: RequestItem = { ...approvalItem, answer: 'once', state: 'answered' }
      const view = renderHost(
        <Harness
          answeredDismissMs={2000}
          items={[approvalItem]}
          onCloseRequest={onCloseRequest}
          open={approvalItem.id}
        />
      )

      fireEvent.press(screen.getByTestId('approval-choice-once'))

      view.rerender(
        withProviders(<Harness answeredDismissMs={2000} items={[answered]} onCloseRequest={onCloseRequest} />)
      )

      expect(screen.getByTestId('approval-resolution')).toBeTruthy()

      act(() => {
        jest.advanceTimersByTime(2000)
      })

      // …and then the slide-out it starts.
      act(() => {
        jest.advanceTimersByTime(500)
      })

      // Gone, and without a dismissal being recorded: an answered question is
      // not one the reader put aside.
      expect(screen.queryByTestId('approval-resolution')).toBeNull()
      expect(onCloseRequest).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('re-arms the tap guard for the next question rather than inheriting the last one', () => {
    jest.useFakeTimers()

    try {
      const onRespondApproval = jest.fn()
      const second: RequestItem = { ...approvalItem, id: 'ap-2', command: 'rm -rf build', requestId: 'srq-9' }
      const view = renderHost(
        <Harness items={[approvalItem]} onRespondApproval={onRespondApproval} open={approvalItem.id} />
      )

      act(() => {
        jest.advanceTimersByTime(400)
      })

      // The first question is answered and a second arrives in its place.
      view.rerender(
        withProviders(
          <Harness
            items={[{ ...approvalItem, answer: 'once', state: 'answered' }, second]}
            onRespondApproval={onRespondApproval}
            open={second.id}
          />
        )
      )

      expect(screen.getByTestId('approval-command')).toHaveTextContent('rm -rf build')
    } finally {
      jest.useRealTimers()
    }
  })

  it('tells the caller about each question exactly once', () => {
    const onShowRequest = jest.fn()
    const view = renderHost(<Harness items={[approvalItem]} onShowRequest={onShowRequest} open={approvalItem.id} />)

    view.rerender(
      withProviders(<Harness items={[approvalItem]} onShowRequest={onShowRequest} open={approvalItem.id} />)
    )

    expect(onShowRequest).toHaveBeenCalledTimes(1)
    expect(onShowRequest).toHaveBeenCalledWith(expect.objectContaining({ id: approvalItem.id }))
  })

  it('offers "Later" rather than "Skip" on a clarify, and only puts it aside', () => {
    const onCloseRequest = jest.fn()

    renderHost(<Harness items={[clarifyItem]} onCloseRequest={onCloseRequest} open={clarifyItem.id} />)

    expect(screen.getByText('Later')).toBeTruthy()

    fireEvent.press(screen.getByTestId('clarify-skip'))
    expect(onCloseRequest).toHaveBeenCalledWith(expect.objectContaining({ id: clarifyItem.id }))
  })
})
