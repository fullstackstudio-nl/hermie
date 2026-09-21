/**
 * The chat screen's wiring.
 *
 * The stores, the selectors and `useChat` are all real here; only the
 * controller is a stand-in, because everything past it is a socket. So what
 * these assertions actually check is the path the screen is responsible for:
 * a reducer state becomes a rendered transcript, an open request becomes the
 * right sheet, and a tap becomes the right controller call with the right
 * arguments. The controller's own round trips are covered in
 * `chat-mockController.test.ts`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { FlatList } from 'react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { haptic } from '../src/platform/haptics'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { deferred, renderScreen } from './support/render'

// `mock`-prefixed so the factory below may close over it (Jest's hoisting rule).
let mockController: Record<string, jest.Mock>
// One runtime object per test, not one per render: `useChat` re-opens the chat
// whenever the runtime's identity changes, and a factory that built a fresh
// object every render re-ran `openChat` on every single re-render.
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

// The picker is a native module with no test implementation; the screen only
// ever awaits what it returns.
jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

const attachments = jest.requireMock('../src/features/chats/attachments') as {
  openAppSettings: jest.Mock
  pickAttachment: jest.Mock
}

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: {
    id: 'stored-researcher',
    resolvedId: 'stored-researcher',
    preview: 'hello',
    lastActive: 1,
    messageCount: 2
  }
}

function makeController() {
  return {
    openChat: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    send: jest.fn(async () => undefined),
    stopTurn: jest.fn(async () => undefined),
    acknowledgeApproval: jest.fn(async () => undefined),
    respondApproval: jest.fn(async () => undefined),
    respondClarify: jest.fn(async () => undefined),
    lockClarify: jest.fn(async () => undefined),
    steerQueued: jest.fn(async () => 'queued'),
    editQueued: jest.fn(() => 'and one more thing'),
    deleteQueued: jest.fn(),
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => ({ items: [] })),
    knowsSlashCommand: jest.fn(() => false),
    runSlash: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    modelOptions: jest.fn(async () => [{ id: 'example-provider/other', label: 'other', provider: 'Example' }])
  }
}

function seedChat() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
  chats.dispatchEvent('researcher', {
    type: 'session.info',
    session_id: 'runtime-1',
    payload: { model: 'example-provider/example-model', yolo: false, fast: false, reasoning_effort: 'medium' }
  })
}

const renderChat = () => renderScreen(<ChatScreen bot="researcher" />)

beforeEach(() => {
  mockController = makeController()
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
  attachments.openAppSettings.mockClear()
  attachments.pickAttachment.mockReset().mockResolvedValue(null)
  seedChat()
})

describe('ChatScreen', () => {
  it('opens the chat and shows the bot in its header', async () => {
    renderChat()

    await waitFor(() =>
      expect(mockController.openChat).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }))
    )
    expect(screen.getByTestId('chat-header')).toBeTruthy()
    // The header leads with the profile name. `Researcher` is that handle in
    // different case, so there is one name here and the second line is the
    // status on its own.
    expect(screen.getByText('researcher')).toBeTruthy()
  })

  it('renders the transcript through the view settings', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Here is what I found.', status: 'ok' }
      })
    })

    renderChat()

    await waitFor(() => expect(screen.getByText('Here is what I found.')).toBeTruthy())
  })

  it('sends the draft through the controller and clears it', async () => {
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), 'hello')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.send).toHaveBeenCalledWith('researcher', 'hello', []))
    expect(useChatsStore.getState().chats.researcher?.draft).toBe('')
    expect(haptic).toHaveBeenCalledWith('send')
  })

  it('goes to the END of the conversation on send, from wherever the reader was', async () => {
    // Reported from the iPad build: the transcript jumped to the TOP right after
    // a message went. Whatever produced it, the requirement is one line — your
    // own message is at the bottom and the bottom is where you are — and on an
    // inverted list that bottom is offset 0. Anything that scrolls by INDEX can
    // land at the far end; this never asks for one.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderChat()

      // Up in the history, which is the case the jump was reported from.
      fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
        nativeEvent: {
          contentOffset: { x: 0, y: 900 },
          contentSize: { height: 4000, width: 402 },
          layoutMeasurement: { height: 800, width: 402 }
        }
      })

      scrollToOffset.mockClear()

      fireEvent.changeText(screen.getByTestId('composer-input'), 'hello')
      fireEvent.press(screen.getByTestId('composer-send'))

      await waitFor(() => expect(mockController.send).toHaveBeenCalled())

      expect(scrollToOffset).toHaveBeenCalledWith({ animated: true, offset: 0 })
      // Nothing ever asked for the other end.
      for (const [call] of scrollToOffset.mock.calls) {
        expect((call as { offset: number }).offset).toBe(0)
      }
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('keeps a staged attachment on screen until the send is actually accepted', async () => {
    // It used to be cleared optimistically, beside the draft. On a failure the
    // draft came back and the file did not — so the one thing the reader could
    // not retype was the one thing that vanished.
    attachments.pickAttachment.mockResolvedValueOnce({
      id: 'a1',
      filename: 'shot.jpg',
      base64: 'AAAA',
      uri: 'file:///tmp/shot.jpg'
    })
    mockController.send.mockRejectedValueOnce(new Error('gateway not connected'))
    renderChat()

    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))
    await waitFor(() => expect(screen.getByTestId('composer-attachments')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('composer-input'), 'look')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(screen.getByText(/gateway not connected/u)).toBeTruthy())
    expect(screen.getByTestId('composer-attachments')).toBeTruthy()

    // And it does go once a send lands, so the tray is not simply sticky.
    fireEvent.press(screen.getByTestId('composer-send'))
    await waitFor(() => expect(screen.queryByTestId('composer-attachments')).toBeNull())
  })

  it('buzzes once when a reply lands and not when a turn merely runs', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })
    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())

    expect(jest.mocked(haptic).mock.calls.filter(([moment]) => moment === 'complete')).toHaveLength(0)

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.complete', seq: 90, payload: { text: 'done' } })
    })

    await waitFor(() =>
      expect(jest.mocked(haptic).mock.calls.filter(([moment]) => moment === 'complete')).toHaveLength(1)
    )
  })

  /**
   * The line under the bot's name, driven the way a turn drives it.
   *
   * The selector has its own table in `@hermie/transcript`; what is asserted
   * here is that the header is reading it at all — the previous line said
   * `Working…` from the first frame of a turn to the last, and the way that
   * survived was that nothing ever looked at it.
   */
  it('says what the bot is doing, and goes quiet when it stops', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })
    await waitFor(() => expect(screen.getByText('Working…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'reasoning.delta', seq: 91, payload: { text: 'Let me think.' } })
    })
    await waitFor(() => expect(screen.getByText('Thinking…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.delta', seq: 92, payload: { text: 'Right — ' } })
    })
    await waitFor(() => expect(screen.getByText('Typing…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'tool.start', seq: 93, payload: { tool_id: 'c1', name: 'terminal' } })
    })
    await waitFor(() => expect(screen.getByText('Running terminal…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.complete', seq: 94, payload: { text: 'Right — done.' } })
    })
    await waitFor(() => expect(screen.getByText('Online')).toBeTruthy())
  })

  it('stops a running turn instead of sending', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })

    // The one round button becomes a stop square while a turn runs.
    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())
    fireEvent.press(screen.getByTestId('composer-stop'))

    await waitFor(() => expect(mockController.stopTurn).toHaveBeenCalledWith('researcher'))
    expect(mockController.send).not.toHaveBeenCalled()
  })

  it('raises the approval sheet for an open request and answers it', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-7',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-7' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.getByTestId('approval-command')).toHaveTextContent('rm -rf build')

    // The queue is told a human is looking before any answer goes back.
    await waitFor(() => expect(mockController.acknowledgeApproval).toHaveBeenCalledWith('researcher', 'srq-7'))

    // The choices are disabled for 400 ms after the sheet appears (ADR-0010:
    // a sheet that opens under a travelling finger must not answer for it), so
    // the press is retried until the guard has released.
    await waitFor(() => {
      fireEvent.press(screen.getByTestId('approval-choice-once'))

      expect(mockController.respondApproval).toHaveBeenCalledWith('researcher', 'srq-7', 'once', undefined)
    })
    expect(haptic).toHaveBeenCalledWith('choice')
  })

  it('closes the approval sheet on the tap, with the answer still in flight', async () => {
    // The sheet used to wait for `approval.respond` to come back and then sit
    // for two seconds saying "Answered: Allow once". It leaves on the tap now:
    // the RPC is a background errand, and the only thing that waits for it is
    // the question's own row in the transcript.
    const answering = deferred<undefined>()
    let settled = false

    void answering.promise.then(() => {
      settled = true
    })

    mockController.respondApproval.mockImplementationOnce(() => answering.promise)

    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-8',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-8' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())

    await waitFor(() => {
      fireEvent.press(screen.getByTestId('approval-choice-once'))

      expect(mockController.respondApproval).toHaveBeenCalledWith('researcher', 'srq-8', 'once', undefined)
    })

    // Gone one slide-out later — and the answer has not been anywhere: nothing
    // resolves that promise until the assertion below has run.
    await waitFor(() => expect(screen.queryByTestId('approval-sheet')).toBeNull(), { timeout: 4000 })
    expect(settled).toBe(false)

    // Still open, still in the transcript, with the way back to it.
    expect(screen.getByText('Answer')).toBeTruthy()

    answering.resolve(undefined)
  })

  it('shows one question at a time, oldest first', async () => {
    renderChat()

    act(() => {
      const chats = useChatsStore.getState()

      chats.dispatchServerRequest('researcher', {
        id: 'srq-1',
        method: 'approval',
        params: { command: 'first', choices: ['once'], request_id: 'appr-1' }
      })
      chats.dispatchServerRequest('researcher', {
        id: 'srq-2',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal'], request_id: 'clar-2' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.queryByTestId('clarify-sheet')).toBeNull()
  })

  it('answers a clarify through the controller', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-9',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal', 'Playful'], request_id: 'clar-9' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('clarify-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('clarify-choice-Playful'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    await waitFor(() =>
      expect(mockController.respondClarify).toHaveBeenCalledWith('researcher', 'srq-9', { 'clar-9': 'Playful' })
    )
  })

  it('sets a gateway option from the options sheet', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-yolo'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'yolo', 'true', {
        confirmExpensiveModel: false
      })
    )
  })

  /**
   * The one switch whose values are not booleans.
   *
   * `config.set {key:'fast'}` is parsed against the gateway's own word list, so
   * `true` came back as 4002 "unknown fast mode: true" and the switch snapped
   * back on every tap. Its neighbour really does take `true`, which is why this
   * went unnoticed: one of the two worked.
   */
  it('sends fast mode as a word the gateway knows, not as a boolean', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'fast', 'fast', {
        confirmExpensiveModel: false
      })
    )
  })

  it('switches fast mode back off with the word for off, not with false', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'session.info',
        session_id: 'runtime-1',
        payload: { model: 'example-provider/example-model', yolo: false, fast: true, reasoning_effort: 'medium' }
      })
    })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'fast', 'normal', {
        confirmExpensiveModel: false
      })
    )
  })

  /**
   * A gateway may refuse the mode itself — "fast mode is not available for this
   * model" is a 4002 as well. The reader has to be told, and the switch has to
   * go back to what the gateway holds rather than sit there claiming a mode
   * nothing accepted.
   */
  it('reports a refused fast mode and leaves the switch where the gateway has it', async () => {
    mockController.setOption.mockRejectedValueOnce(new Error('fast mode is not available for this model'))
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() => expect(mockController.setOption).toHaveBeenCalled())

    // Nothing dispatched a `session.info`, so the switch still reads what the
    // gateway last said — off — rather than staying where the tap put it.
    expect(screen.getByTestId('option-fast').props.accessibilityState?.checked).toBe(false)

    // The sheet is a modal, so the banner underneath it is only reachable once
    // the reader is done with the sheet. That is where the refusal is waiting.
    fireEvent.press(screen.getByTestId('chat-options-done'))

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'Setting not changed: fast mode is not available for this model'
      )
    )
    // NOT the open-failure sentence. The conversation is open, readable and
    // still streaming; only the setting was refused.
    expect(screen.queryByText(/could not be opened/u)).toBeNull()
    // And no Try again: reloading rebuilds a conversation that is already here.
    expect(screen.queryByText('Try again')).toBeNull()
    expect(screen.getByTestId('chat-error-dismiss')).toBeTruthy()
  })

  it('keeps verbosity local to the app rather than sending it to the gateway', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-verbosity-quiet'))

    await waitFor(() => expect(useSettingsStore.getState().perChat.researcher?.level).toBe('quiet'))
    expect(mockController.setOption).not.toHaveBeenCalled()
  })

  it('offers "use the default" once the chat pins its own view, and resets it', async () => {
    useSettingsStore.getState().setChatView('researcher', { level: 'verbose' })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-use-default')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-use-default'))

    await waitFor(() => expect(useSettingsStore.getState().perChat.researcher).toBeUndefined())
  })

  it('asks before switching to a model the gateway flagged as expensive', async () => {
    mockController.setOption.mockResolvedValueOnce({ confirmRequired: true, confirmMessage: 'That one bills more.' })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-model'))
    await waitFor(() => expect(screen.getByTestId('picker-option-example-provider/other')).toBeTruthy())
    fireEvent.press(screen.getByTestId('picker-option-example-provider/other'))

    await waitFor(() => expect(screen.getByTestId('option-model-confirm')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-model-confirm'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenLastCalledWith('researcher', 'model', 'example-provider/other', {
        confirmExpensiveModel: true
      })
    )
  })

  it('pins the agents bar while children are running', async () => {
    renderChat()

    expect(screen.queryByTestId('agents-bar')).toBeNull()

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'subagent.start',
        session_id: 'runtime-1',
        payload: { subagent_id: 'sub-1', goal: 'Read the docs', task_index: 0, task_count: 1 }
      })
    })

    await waitFor(() => expect(screen.getByTestId('agents-bar')).toBeTruthy())
  })

  it('says so when no bot is selected', () => {
    renderScreen(<ChatScreen />)

    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
  })

  it('presents a request that arrives while the options sheet is open', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-11',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-11' }
      })
    })

    // This is the one the four sibling modals lost: iOS presented the options
    // sheet and never showed the question underneath it.
    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('keeps saying it is waiting for you after a question is put aside', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-12',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal'], request_id: 'clar-12' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('clarify-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('clarify-skip'))

    // "Later" takes the sheet away and nothing else: the agent is still
    // blocked, so the header must not go back to the idle label.
    // The sheet leaves after its close animation (or the host's settle
    // fallback), which can take longer than the default wait on a slow runner.
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull(), { timeout: 4000 })
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    // …and the transcript still offers the way back to it.
    expect(screen.getByText('Answer')).toBeTruthy()
  })

  it('counts messages rather than rows in the jump-to-latest pill', async () => {
    renderChat()

    // Scroll away from the bottom (the list is inverted: offset 0 IS the
    // bottom), which is the only state in which the pill counts anything.
    act(() => {
      fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
        nativeEvent: {
          contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
          contentOffset: { x: 0, y: 400 },
          contentSize: { height: 2000, width: 402 },
          layoutMeasurement: { height: 874, width: 402 }
        }
      })
    })

    await waitFor(() => expect(screen.getByText('Jump to latest')).toBeTruthy())

    act(() => {
      // A tool call and a status row are not messages. Counting them announced
      // "4 new" for one `ls`.
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.start',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_1', name: 'bash', args: { command: 'ls' } }
      })
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.complete',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_1', name: 'bash', result: { ok: true } }
      })
    })

    // The pill carries the count as a badge beside its own name, so the number
    // is what appears and disappears — and it says it in the label too, for
    // anyone who cannot see a badge.
    expect(screen.queryByLabelText(/Jump to latest, \d+ new/u)).toBeNull()

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Here it is.', status: 'ok' }
      })
    })

    await waitFor(() => expect(screen.getByLabelText(/Jump to latest, 1 new/u)).toBeTruthy())
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('offers the way out of a refused photo picker, and only for that', async () => {
    attachments.pickAttachment.mockRejectedValueOnce(
      new Error('Hermie needs access to your photo library to attach an image. Allow it in Settings.')
    )
    renderChat()

    // The "+" opens the menu; the photo picker is its own entry.
    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))

    await waitFor(() => expect(screen.getByTestId('chat-open-settings')).toBeTruthy())
    fireEvent.press(screen.getByTestId('chat-open-settings'))
    expect(attachments.openAppSettings).toHaveBeenCalled()

    // Any other failure has no such button: there is nothing in Settings to fix.
    fireEvent.press(screen.getByTestId('chat-error-dismiss'))
    attachments.pickAttachment.mockRejectedValueOnce(new Error('the picker exploded'))
    // The menu closed itself when the picker went away, so this opens it again —
    // which is the behaviour that stops a cancelled picker leaving the menu
    // standing over the composer.
    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))

    await waitFor(() => expect(screen.getByText(/the picker exploded/u)).toBeTruthy())
    expect(screen.queryByTestId('chat-open-settings')).toBeNull()
  })

  /**
   * The `+` menu used to be an ordinary child above the composer row, so opening
   * it added its own height to the composer — and a composer that grows pushes
   * the transcript up. Tapping `+` moved the conversation the reader was
   * looking at, which is the one thing a menu must not do.
   *
   * What a test renderer can see is the structure that decides it: the popover
   * is positioned absolutely off the composer's bottom edge, so it is drawn over
   * the transcript and contributes nothing to the composer's layout, and the
   * row's own style is untouched by it.
   */
  it('floats the attach menu over the transcript instead of growing the composer', () => {
    renderChat()

    const rowStyleClosed = JSON.stringify(screen.getByTestId('composer-row').props.style)
    expect(screen.queryByTestId('composer-attach-backdrop', HIDDEN)).toBeNull()

    fireEvent.press(screen.getByTestId('composer-attach'))

    // The popover's wrapper takes the composer out of the question entirely.
    const floated = screen.getByTestId('composer-attach-layer')
    expect(flatStyle(floated.props.style)).toMatchObject({ bottom: expect.any(Number), position: 'absolute' })
    expect(within(floated, screen.getByTestId('composer-attach-menu'))).toBe(true)

    // And the row it sits over is the same row it was before the tap.
    expect(JSON.stringify(screen.getByTestId('composer-row').props.style)).toBe(rowStyleClosed)
  })

  it('puts the attach menu away on a tap outside it', () => {
    renderChat()

    fireEvent.press(screen.getByTestId('composer-attach'))
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()

    // Hidden from VoiceOver on purpose — it is a tap catcher, not a control, and
    // the gesture that dismisses a popover for a screen reader is its own.
    fireEvent.press(screen.getByTestId('composer-attach-backdrop', HIDDEN))

    // The menu itself is still mounted for one exit — it animates out now that it
    // has no tail to say where it came from — but it is inert while it goes and
    // the catcher is gone on the frame.
    expect(screen.getByTestId('composer-attach-appear').props.pointerEvents).toBe('none')
    expect(screen.queryByTestId('composer-attach-backdrop', HIDDEN)).toBeNull()
  })

  it('dismisses a controller error from the banner', async () => {
    mockController.openChat.mockRejectedValueOnce(new Error('gateway not connected'))
    renderChat()

    // A chat that would not open keeps its own sentence, and its Try again.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'This conversation could not be opened: gateway not connected'
      )
    )
    expect(screen.getByText('Try again')).toBeTruthy()

    fireEvent.press(screen.getByTestId('chat-error-dismiss'))

    // "Done" used to clear only the screen's own notice, so a failed open left
    // a banner no button on it could remove.
    await waitFor(() => expect(screen.queryByText(/gateway not connected/u)).toBeNull())
  })
})

/** The tap catcher is hidden from accessibility, which is what this opts past. */
const HIDDEN = { includeHiddenElements: true } as const

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}

/** One object out of whatever a style prop happens to be: array, nested, or plain. */
function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((merged, entry) => ({ ...merged, ...flatStyle(entry) }), {})
  }

  return (style ?? {}) as Record<string, unknown>
}

describe('following a DM across chats', () => {
  /** Writer's chat, holding the inbound view of a message researcher sent. */
  function seedWriter(at: number, text: string) {
    useChatsStore.getState().ensure('writer', { storedSessionId: 'stored-writer', resolvedSessionId: 'stored-writer' })
    useChatsStore.getState().update('writer', state => ({
      ...state,
      items: {
        'w:1': {
          id: 'w:1',
          kind: 'bot_dm_in',
          origin: 'history',
          senderHandle: 'researcher',
          senderName: 'Researcher',
          seq: 1000,
          text,
          ts: at,
          version: 0
        }
      },
      order: ['w:1']
    }))
  }

  const dispatchDm = (text: string, ts: number) => {
    const chats = useChatsStore.getState()

    chats.dispatchEvent('researcher', {
      type: 'tool.start',
      session_id: 'runtime-1',
      payload: { tool_id: 'call_dm_1', name: 'message_agent', args: { target: '@writer', message: text } }
    })
    chats.dispatchEvent('researcher', {
      type: 'tool.complete',
      session_id: 'runtime-1',
      payload: {
        tool_id: 'call_dm_1',
        name: 'message_agent',
        result: { status: 'queued', process_id: 'p-1', to: 'writer' }
      }
    })
    chats.dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Asked the writer.', status: 'ok', ts }
    })
  }

  /**
   * The line these tests press is the expanded one, which Quiet (the default)
   * folds to a chip. The screen hydrates the settings store on mount, which
   * replaces `perChat`, so the level has to be set once that has happened.
   */
  async function showFullDmLines() {
    await waitFor(() => expect(useSettingsStore.getState().loaded).toBe(true))
    act(() => {
      useSettingsStore.getState().setChatView('researcher', { level: 'normal' })
    })
  }

  it('opens the recipient on the matching inbound message', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
      seedWriter(1_700_000_020, 'Can you draft the announcement?')
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)
    await showFullDmLines()

    // Tapping the LINE expands it in place and navigates nowhere (§6.6); the
    // explicit link inside is what opens the other chat, and it still lands on
    // the matching inbound row rather than at the bottom.
    await waitFor(() => expect(screen.getByTestId('bot-dm-out-line-t:call_dm_1')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-out-line-t:call_dm_1'))
    expect(onOpenBot).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('bot-dm-out-open-t:call_dm_1'))

    expect(onOpenBot).toHaveBeenCalledWith('writer', { focusItemId: 'w:1' })
  })

  it('still opens the chat when no counterpart can be matched', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)
    await showFullDmLines()

    // Tapping the LINE expands it in place and navigates nowhere (§6.6); the
    // explicit link inside is what opens the other chat, and it still lands on
    // the matching inbound row rather than at the bottom.
    await waitFor(() => expect(screen.getByTestId('bot-dm-out-line-t:call_dm_1')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-out-line-t:call_dm_1'))
    expect(onOpenBot).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('bot-dm-out-open-t:call_dm_1'))

    // No focus target rather than a wrong one: the chat opens at its bottom.
    expect(onOpenBot).toHaveBeenCalledWith('writer', undefined)
  })
})

describe('a line that starts with a slash', () => {
  it('runs as a command when the gateway has one by that name', async () => {
    mockController.knowsSlashCommand.mockReturnValue(true)
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), '/model')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.runSlash).toHaveBeenCalledWith('researcher', '/model'))
    // No turn: `slash.exec` answers with text, and the text lands in the
    // transcript as a notice.
    expect(mockController.send).not.toHaveBeenCalled()
  })

  it('is an ordinary prompt when it is not a command this profile has', async () => {
    mockController.knowsSlashCommand.mockReturnValue(false)
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), '/usr/local/bin is where it lives')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() =>
      expect(mockController.send).toHaveBeenCalledWith('researcher', '/usr/local/bin is where it lives', [])
    )
    expect(mockController.runSlash).not.toHaveBeenCalled()
  })
})

describe('a message sent while the bot is working', () => {
  it('stands over the composer as a strip, with its three actions', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
      useChatsStore.getState().enqueue('researcher', { id: 'q:1', text: 'and one more thing' })
    })

    await waitFor(() => expect(screen.getByTestId('queued-strip')).toBeTruthy())
    // NOT in the transcript: a parked message has not happened yet, and a
    // bubble is a thing that did.
    expect(screen.queryByTestId('queued-q:1')).toBeNull()
    expect(screen.getByText('and one more thing')).toBeTruthy()

    // Steer: into the turn that is running, now.
    fireEvent.press(screen.getByTestId('queued-steer-q:1'))
    await waitFor(() => expect(mockController.steerQueued).toHaveBeenCalledWith('researcher', 'q:1'))

    // Edit: back into the field it came from.
    fireEvent.press(screen.getByTestId('queued-edit-q:1'))
    await waitFor(() => expect(useChatsStore.getState().chats.researcher?.draft).toBe('and one more thing'))

    fireEvent.press(screen.getByTestId('queued-delete-q:1'))
    expect(mockController.deleteQueued).toHaveBeenCalledWith('researcher', 'q:1')
  })

  it('offers no Edit for one carrying an attachment, which the field cannot take back', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
      useChatsStore
        .getState()
        .enqueue('researcher', { id: 'q:2', text: 'look at this', attachments: ['@image:shot.png'] })
    })

    await waitFor(() => expect(screen.getByTestId('queued-strip')).toBeTruthy())

    expect(screen.getByTestId('queued-steer-q:2')).toBeTruthy()
    expect(screen.getByTestId('queued-delete-q:2')).toBeTruthy()
    expect(screen.queryByTestId('queued-edit-q:2')).toBeNull()
    // The file travels with the message, so the strip names it beside the text.
    expect(screen.getByText(/look at this · shot\.png/)).toBeTruthy()
  })

  it('can be sent at all while a turn runs, which the round button used to refuse', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
    })

    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())

    // Typing turns the stop square back into a send arrow: the message is
    // parked behind the turn, and the reply is not thrown away for it.
    fireEvent.changeText(screen.getByTestId('composer-input'), 'and one more thing')

    expect(screen.queryByTestId('composer-stop')).toBeNull()
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.send).toHaveBeenCalledWith('researcher', 'and one more thing', []))
    expect(mockController.stopTurn).not.toHaveBeenCalled()
  })
})

describe('the typing indicator', () => {
  it('shows while the turn has said nothing and stops once a tool is the only thing running', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.start',
        session_id: 'runtime-1',
        payload: {}
      })
    })

    await waitFor(() => expect(screen.getByTestId('typing-indicator')).toBeTruthy())

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Done.', status: 'ok' }
      })
      // A child is still running: the chat is BUSY but nothing is about to be
      // said, so the dots must be gone.
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'subagent.start',
        session_id: 'runtime-1',
        payload: { subagent_id: 'sa-1', goal: 'Audit deps', status: 'running', delegation_id: 'del-1' }
      })
    })

    await waitFor(() => expect(screen.queryByTestId('typing-indicator')).toBeNull())
  })
})
