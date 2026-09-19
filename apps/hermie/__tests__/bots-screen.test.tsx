/**
 * The chat list as a screen: what a row shows, and what a tap does.
 *
 * The roster, the running set and the open requests come from three different
 * stores on purpose (see `BotsScreen`), so the assertions here are mostly about
 * a row correctly reading all three at once.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

const NOW = Math.floor(Date.now() / 1000)

const bot = (patch: Partial<Bot> & { name: string }): Bot => ({
  displayName: patch.name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  ...patch
})

const ROSTER: Bot[] = [
  bot({
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Finds things out.',
    canonical: {
      id: 'stored-researcher',
      resolvedId: 'stored-researcher',
      preview: 'Message from 🤖 Writer (@writer): Draft is ready, I pushed it.',
      lastActive: NOW - 30,
      messageCount: 12
    }
  }),
  bot({
    name: 'writer',
    displayName: 'Writer',
    description: 'Writes things down.',
    canonical: {
      id: 'stored-writer',
      resolvedId: 'stored-writer',
      preview: 'Which tone should I use?',
      lastActive: NOW - 7200,
      messageCount: 4
    }
  })
]

function seedRoster() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useBotsStore.getState().setBots(ROSTER)
}

/** An open approval in Writer's chat — the "needs your input" badge's source. */
function seedOpenApproval() {
  useChatsStore.getState().ensure('writer', { storedSessionId: 'stored-writer', resolvedSessionId: 'stored-writer' })
  useChatsStore.getState().dispatchServerRequest('writer', {
    id: 'srq-1',
    method: 'approval',
    params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-1' }
  })
}

describe('BotsScreen', () => {
  beforeEach(seedRoster)

  it('renders a row per bot with its preview and stamp', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
    expect(screen.getByText('Researcher')).toBeTruthy()
    expect(screen.getByText('Which tone should I use?')).toBeTruthy()
  })

  it('folds a "Message from" preview down to the sender handle', () => {
    renderScreen(<BotsScreen />)

    expect(screen.getByText('🤖 @writer: Draft is ready, I pushed it.')).toBeTruthy()
  })

  it('falls back to the description when the chat has no preview yet', () => {
    useBotsStore.getState().setBots([bot({ name: 'builder', displayName: 'Builder', description: 'Builds things.' })])
    renderScreen(<BotsScreen />)

    expect(screen.getByText('Builds things.')).toBeTruthy()
  })

  it('marks a bot unread until its chat has been looked at', () => {
    // The dot itself is hidden from assistive tech on purpose — the row's own
    // accessibility label carries "New" — so the query has to opt in.
    const dots = () => screen.queryAllByTestId('bot-unread', { includeHiddenElements: true })

    renderScreen(<BotsScreen />)
    expect(dots()).toHaveLength(2)

    screen.unmount()
    useBotsStore.getState().markSeen('writer', NOW)
    renderScreen(<BotsScreen />)

    expect(dots()).toHaveLength(1)
  })

  it('names the unread and waiting state on the row itself, for a screen reader', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    expect(screen.getByLabelText('Researcher, New, working')).toBeTruthy()
  })

  it('shows the working indicator for a bot the gateway reports as busy', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-running-researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-running-writer')).toBeNull()
  })

  it('badges the bot whose chat is waiting on an answer', () => {
    seedOpenApproval()
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-needs-input-writer')).toBeTruthy()
    expect(screen.queryByTestId('bot-needs-input-researcher')).toBeNull()
  })

  it('filters by name and by description', () => {
    renderScreen(<BotsScreen />)

    fireEvent.changeText(screen.getByTestId('bots-search'), 'writ')
    expect(screen.queryByTestId('bot-row-researcher')).toBeNull()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()

    fireEvent.changeText(screen.getByTestId('bots-search'), 'finds things')
    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()

    fireEvent.changeText(screen.getByTestId('bots-search'), 'nobody')
    expect(screen.getByTestId('bots-empty')).toBeTruthy()
  })

  it('opens the tapped bot', () => {
    const onOpenBot = jest.fn()

    renderScreen(<BotsScreen onOpenBot={onOpenBot} />)
    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(onOpenBot).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }))
  })

  it('offers the other sections only where a shell asked for the tabs', () => {
    const onOpenSection = jest.fn()

    renderScreen(<BotsScreen />)
    expect(screen.queryByTestId('tab-settings')).toBeNull()

    screen.unmount()
    renderScreen(<BotsScreen onOpenSection={onOpenSection} />)
    fireEvent.press(screen.getByTestId('tab-routines'))

    expect(onOpenSection).toHaveBeenCalledWith('cron')
  })

  it('explains an empty roster', () => {
    useBotsStore.getState().setBots([])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bots-empty')).toBeTruthy()
  })
})

describe('the unread badge', () => {
  beforeEach(() => {
    seedRoster()
    // Writer is caught up, so exactly one badge is on screen to assert on.
    useBotsStore.getState().markSeen('writer', NOW)
  })

  /** Two replies and one inbound DM landing after the watermark. */
  function seedUnread(sinceSeconds: number) {
    const chats = useChatsStore.getState()

    chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    chats.update('researcher', state => ({
      ...state,
      items: {
        a1: {
          id: 'a1',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 1000,
          streaming: false,
          text: 'One.',
          ts: sinceSeconds + 1,
          version: 0
        },
        a2: {
          id: 'a2',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 2000,
          streaming: false,
          text: 'Two.',
          ts: sinceSeconds + 2,
          version: 0
        },
        d1: {
          id: 'd1',
          kind: 'bot_dm_in',
          origin: 'live',
          senderName: 'Writer',
          seq: 3000,
          text: 'Ready.',
          ts: sinceSeconds + 3,
          version: 0
        },
        // Before the watermark: already read.
        a0: {
          id: 'a0',
          kind: 'assistant',
          interim: false,
          origin: 'live',
          seq: 500,
          streaming: false,
          text: 'Old.',
          ts: sinceSeconds - 10,
          version: 0
        }
      },
      order: ['a0', 'a1', 'a2', 'd1']
    }))
  }

  it('counts messages since the watermark once the chat is loaded', () => {
    useBotsStore.getState().markSeen('researcher', NOW - 60)
    seedUnread(NOW - 60)

    renderScreen(<BotsScreen />)

    // Hidden from the screen reader on purpose: the row's own label already
    // says "3 unread messages", and a bare "3" after it would read twice.
    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toHaveTextContent('3')
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).toContain('3 unread messages')
  })

  it('caps the number rather than widening the badge', () => {
    useBotsStore.getState().markSeen('researcher', NOW - 60)

    const items: Record<string, unknown> = {}
    const order: string[] = []

    for (let index = 0; index < 120; index += 1) {
      const id = `a${index}`

      items[id] = {
        id,
        kind: 'assistant',
        interim: false,
        origin: 'live',
        seq: index * 10,
        streaming: false,
        text: `Line ${index}`,
        ts: NOW - 59 + index,
        version: 0
      }
      order.push(id)
    }

    useChatsStore
      .getState()
      .ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    useChatsStore.getState().update('researcher', state => ({ ...state, items: items as never, order }))

    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toHaveTextContent('99+')
  })

  it('falls back to a dot for a chat this app has never read', () => {
    renderScreen(<BotsScreen />)

    // The roster says researcher moved since the watermark, but nothing is
    // loaded, so there is nothing honest to count.
    expect(screen.getByTestId('bot-unread', { includeHiddenElements: true })).toBeTruthy()
    expect(screen.queryByText('3')).toBeNull()
  })
})
