/**
 * The Activity screen.
 *
 * The stores and the `@hermie/transcript` projection are real here; only the
 * controller is a stand-in, because everything past it is a socket. What these
 * assertions check is therefore the screen's own job: transcripts the store
 * already holds become timeline rows, the three counters come from the three
 * calls they are supposed to come from, and a tap carries the item id that lets
 * the chat land on the right message.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { ActivityScreen } from '../src/features/activity'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

let mockController: Record<string, jest.Mock>
let mockBots: Record<string, jest.Mock>

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => ({ controller: mockController, bots: mockBots })
}))

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: '', lastActive: 1, messageCount: 2 }
})

const RESEARCHER = bot('researcher', 'Researcher')
const WRITER = bot('writer', 'Writer')

/** Researcher dispatches a DM to writer and delegates two tasks. */
function seed() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useBotsStore.getState().setBots([RESEARCHER, WRITER])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-r')

  chats.dispatchEvent('researcher', {
    type: 'tool.start',
    session_id: 'runtime-r',
    payload: {
      tool_id: 'call_dm_1',
      name: 'message_agent',
      args: { target: '@writer', message: 'Can you draft the announcement?' }
    }
  })
  chats.dispatchEvent('researcher', {
    type: 'tool.complete',
    session_id: 'runtime-r',
    payload: {
      tool_id: 'call_dm_1',
      name: 'message_agent',
      result: { status: 'queued', delivery_id: 'dlv-1', to: 'writer', process_id: 'proc-1' }
    }
  })

  for (const [index, goal] of ['Audit deps', 'Write tests'].entries()) {
    chats.dispatchEvent('researcher', {
      type: 'subagent.start',
      session_id: 'runtime-r',
      payload: {
        subagent_id: `child-${index}`,
        delegation_id: 'del-1',
        goal,
        task_index: index,
        task_count: 2,
        status: 'running'
      }
    })
  }
}

beforeEach(() => {
  mockController = {
    loadActivity: jest.fn(async () => undefined),
    activeSubagentCount: jest.fn(async () => 2),
    inFlightDeliveries: jest.fn(async () => 1)
  }
  mockBots = { watchRunning: jest.fn(() => () => undefined) }
  seed()
})

describe('ActivityScreen', () => {
  it('runs the background load so bots nobody opened still appear', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(mockController.loadActivity).toHaveBeenCalled())
  })

  it('renders a dispatch, its delegation and their status', async () => {
    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())
    expect(screen.getByText('Can you draft the announcement?')).toBeTruthy()
    expect(screen.getByText('Researcher spawned 2 agents')).toBeTruthy()
  })

  it('shows a reply as its own row once the delivery reports back', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-r',
        payload: { text: 'Asked the writer.', status: 'ok' }
      })
      useChatsStore.getState().update('researcher', state => {
        const id = state.byProcessId['proc-1']!
        const item = state.items[id]!

        return {
          ...state,
          items: {
            ...state.items,
            [id]: { ...item, reply: { text: 'Draft is ready.' }, version: item.version + 1 }
          }
        }
      })
    })

    renderScreen(<ActivityScreen />)

    // The variation selector is part of the string: without it iOS renders the
    // arrow as an emoji (see `docs/platform-notes.md`).
    await waitFor(() => expect(screen.getByText('Writer \u21a9\ufe0e Researcher')).toBeTruthy())
    expect(screen.getByText('Draft is ready.')).toBeTruthy()
  })

  it('counts bots working, live sub-agents and deliveries in flight', async () => {
    act(() => {
      useBotsStore.getState().setRunning(['researcher'])
    })

    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByTestId('activity-count-subagents')).toHaveTextContent('2'))
    expect(screen.getByTestId('activity-count-working')).toHaveTextContent('1')
    expect(screen.getByTestId('activity-count-deliveries')).toHaveTextContent('1')
    expect(mockController.activeSubagentCount).toHaveBeenCalled()
    expect(mockController.inFlightDeliveries).toHaveBeenCalled()
  })

  it('opens the chat a row came from, carrying the item to scroll to', async () => {
    const onOpenBot = jest.fn()

    renderScreen(<ActivityScreen onOpenBot={onOpenBot} />)

    await waitFor(() => expect(screen.getByText('Researcher → Writer')).toBeTruthy())
    fireEvent.press(screen.getByTestId('activity-row-researcher:t:call_dm_1'))

    expect(onOpenBot).toHaveBeenCalledWith('researcher', { focusItemId: 't:call_dm_1' })
  })

  it('says so when nothing has happened yet rather than showing an empty list', async () => {
    act(() => {
      useChatsStore.getState().reset()
    })

    renderScreen(<ActivityScreen />)

    await waitFor(() => expect(screen.getByTestId('activity-empty')).toBeTruthy())
  })
})
