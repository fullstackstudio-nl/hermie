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

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { haptic } from '../src/platform/haptics'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

// `mock`-prefixed so the factory below may close over it (Jest's hoisting rule).
let mockController: Record<string, jest.Mock>
// One runtime object per test, not one per render: `useChat` re-opens the chat
// whenever the runtime's identity changes, and a factory that built a fresh
// object every render re-ran `openChat` on every single re-render.
let mockRuntime: { controller: Record<string, jest.Mock>; bots: Record<string, never> }

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
  attachmentKind: 'photo',
  attachmentsSupported: true,
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
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => []),
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
  mockRuntime = { bots: {}, controller: mockController }
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
    expect(screen.getByText('Researcher')).toBeTruthy()
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
    // blocked, so the header must not go back to saying Connected.
    await waitFor(() => expect(screen.queryByTestId('clarify-sheet')).toBeNull())
    expect(screen.getByText('Needs your input')).toBeTruthy()
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

    expect(screen.queryByText(/new$/u)).toBeNull()

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Here it is.', status: 'ok' }
      })
    })

    await waitFor(() => expect(screen.getByText('1 new')).toBeTruthy())
  })

  it('offers the way out of a refused photo picker, and only for that', async () => {
    attachments.pickAttachment.mockRejectedValueOnce(
      new Error('Hermie needs access to your photo library to attach an image. Allow it in Settings.')
    )
    renderChat()

    fireEvent.press(screen.getByTestId('composer-attach'))

    await waitFor(() => expect(screen.getByTestId('chat-open-settings')).toBeTruthy())
    fireEvent.press(screen.getByTestId('chat-open-settings'))
    expect(attachments.openAppSettings).toHaveBeenCalled()

    // Any other failure has no such button: there is nothing in Settings to fix.
    fireEvent.press(screen.getByTestId('chat-error-dismiss'))
    attachments.pickAttachment.mockRejectedValueOnce(new Error('the picker exploded'))
    fireEvent.press(screen.getByTestId('composer-attach'))

    await waitFor(() => expect(screen.getByText(/the picker exploded/u)).toBeTruthy())
    expect(screen.queryByTestId('chat-open-settings')).toBeNull()
  })

  it('dismisses a controller error from the banner', async () => {
    mockController.openChat.mockRejectedValueOnce(new Error('gateway not connected'))
    renderChat()

    await waitFor(() => expect(screen.getByText(/gateway not connected/u)).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-error-dismiss'))

    // "Done" used to clear only the screen's own notice, so a failed open left
    // a banner no button on it could remove.
    await waitFor(() => expect(screen.queryByText(/gateway not connected/u)).toBeNull())
  })
})

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

  it('opens the recipient on the matching inbound message', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
      seedWriter(1_700_000_020, 'Can you draft the announcement?')
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)

    await waitFor(() => expect(screen.getByTestId('bot-dm-out-header-t:call_dm_1')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-out-header-t:call_dm_1'))

    expect(onOpenBot).toHaveBeenCalledWith('writer', { focusItemId: 'w:1' })
  })

  it('still opens the chat when no counterpart can be matched', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)

    await waitFor(() => expect(screen.getByTestId('bot-dm-out-header-t:call_dm_1')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-out-header-t:call_dm_1'))

    // No focus target rather than a wrong one: the chat opens at its bottom.
    expect(onOpenBot).toHaveBeenCalledWith('writer', undefined)
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
