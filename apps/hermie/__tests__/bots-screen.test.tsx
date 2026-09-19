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
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

// Two modules, because the gateway card reaches for the provider directly
// rather than through the barrel — it needs the sign-in action, not just the
// status.
const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    signOut: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {}
  })
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
  useChatLayoutStore.getState().reset()
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

  it('names the presence and unread state on the row itself, for a screen reader', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    // The bead never carries the state on colour alone; this label is what a
    // screen reader gets instead of it.
    expect(screen.getByLabelText('Researcher, Working…, New')).toBeTruthy()
    expect(screen.getByLabelText('Writer, Online, New')).toBeTruthy()
  })

  it('shows the working state for a bot the gateway reports as busy', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-presence-researcher')).toBeTruthy()
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).toContain('Working…')
    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).not.toContain('Working…')
  })

  it('outranks working with needs-input for the chat waiting on an answer', () => {
    useBotsStore.getState().setRunning(['writer'])
    seedOpenApproval()
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).toContain('Needs input')
    expect(screen.getByTestId('bot-row-researcher').props.accessibilityLabel).not.toContain('Needs input')
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
    fireEvent.press(screen.getByTestId('tab-cron'))

    expect(onOpenSection).toHaveBeenCalledWith('cron')
  })

  it('explains an empty roster', () => {
    useBotsStore.getState().setBots([])
    renderScreen(<BotsScreen />)

    expect(screen.getByTestId('bots-empty')).toBeTruthy()
  })
})

describe('the filter chips', () => {
  beforeEach(seedRoster)

  it('filters on exactly the presence states, not on anything else', () => {
    useBotsStore.getState().setRunning(['researcher'])
    renderScreen(<BotsScreen />)

    fireEvent.press(screen.getByTestId('filter-working'))
    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()

    fireEvent.press(screen.getByTestId('filter-all'))
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  it('filters on needs-input', () => {
    seedOpenApproval()
    renderScreen(<BotsScreen />)

    fireEvent.press(screen.getByTestId('filter-needsInput'))

    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-researcher')).toBeNull()
  })

  it('filters on unread', () => {
    useBotsStore.getState().markSeen('writer', NOW)
    renderScreen(<BotsScreen />)

    fireEvent.press(screen.getByTestId('filter-unread'))

    expect(screen.getByTestId('bot-row-researcher')).toBeTruthy()
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()
  })

  it('says so when a state is simply empty, rather than reading as an empty roster', () => {
    renderScreen(<BotsScreen />)

    fireEvent.press(screen.getByTestId('filter-working'))

    expect(screen.getByTestId('bots-empty')).toHaveTextContent('No conversation is in that state right now.')
  })
})

describe('edit mode', () => {
  beforeEach(seedRoster)

  it('reveals the move controls and the divider action, and hides them again', () => {
    renderScreen(<BotsScreen />)

    expect(screen.queryByTestId('bot-move-up-writer')).toBeNull()

    fireEvent.press(screen.getByTestId('bots-edit'))
    expect(screen.getByTestId('bot-move-up-writer')).toBeTruthy()
    expect(screen.getByTestId('add-divider')).toBeTruthy()

    fireEvent.press(screen.getByTestId('bots-edit'))
    expect(screen.queryByTestId('bot-move-up-writer')).toBeNull()
  })

  it('reorders a bot with the explicit control', () => {
    renderScreen(<BotsScreen />)
    fireEvent.press(screen.getByTestId('bots-edit'))

    expect(useChatLayoutStore.getState().entries.map(entry => entry.kind === 'chat' && entry.name)).toEqual([
      'researcher',
      'writer'
    ])

    fireEvent.press(screen.getByTestId('bot-move-up-writer'))

    expect(useChatLayoutStore.getState().entries.map(entry => entry.kind === 'chat' && entry.name)).toEqual([
      'writer',
      'researcher'
    ])
  })

  it('adds a divider and keeps it on screen while it is still empty', () => {
    renderScreen(<BotsScreen />)
    fireEvent.press(screen.getByTestId('bots-edit'))
    fireEvent.press(screen.getByTestId('add-divider'))

    const divider = useChatLayoutStore.getState().entries.find(entry => entry.kind === 'divider')

    // Named by typing, not by editing a seeded word: a pre-filled name means
    // the first thing typed lands after it.
    expect(divider).toEqual({ kind: 'divider', id: expect.any(String), name: '' })
    // Empty, but visible: there has to be something to move a row into.
    expect(screen.getByTestId(`divider-${(divider as { id: string }).id}`)).toBeTruthy()
  })
})

describe('the row context menu', () => {
  beforeEach(seedRoster)

  it('opens on a long press and archives the bot out of the list', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')
    fireEvent.press(screen.getByTestId('row-menu-archive'))

    expect(useChatLayoutStore.getState().archived).toEqual({ writer: true })
    // Out of the list proper, and folded under the archived disclosure instead.
    expect(screen.queryByTestId('bot-row-writer')).toBeNull()
    expect(screen.getByTestId('archived-row')).toHaveTextContent(/Archived \(1\)/)
  })

  it('keeps an archived bot out of the filters and the unread count', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')
    fireEvent.press(screen.getByTestId('row-menu-archive'))
    fireEvent.press(screen.getByTestId('filter-unread'))

    expect(screen.queryByTestId('bot-row-writer')).toBeNull()

    // It is still reachable, just not counted: the disclosure opens it.
    fireEvent.press(screen.getByTestId('archived-row'))
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer').props.accessibilityLabel).not.toContain('New')
  })

  it('sets a per-chat colour, and Default stores nothing', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')
    fireEvent.press(screen.getByTestId('swatch-writer-teal'))
    expect(useChatLayoutStore.getState().accents).toEqual({ writer: 'teal' })

    fireEvent.press(screen.getByTestId('swatch-writer-default'))
    expect(useChatLayoutStore.getState().accents).toEqual({})
  })

  it('moves a bot into a named section', () => {
    useChatLayoutStore.getState().reconcile(['researcher', 'writer'])
    const id = useChatLayoutStore.getState().addDivider('Finance')

    renderScreen(<BotsScreen />)
    fireEvent(screen.getByTestId('bot-row-researcher'), 'longPress')
    fireEvent.press(screen.getByTestId(`row-menu-section-${id}`))

    const entries = useChatLayoutStore.getState().entries

    expect(entries[entries.length - 1]).toEqual({ kind: 'chat', name: 'researcher' })
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

/**
 * A phone has no room to spend a permanent row on a green dot that says what
 * the green dot beside every bot already says. So the gateway card is the wide
 * layout's, and on a phone the connection speaks only when it wants something.
 */
describe('the connection state on the two layouts', () => {
  beforeEach(seedRoster)

  afterEach(() => {
    gateway.status = 'ready'
  })

  it('says nothing at all on a phone while the gateway is ready', () => {
    renderScreen(<BotsScreen onOpenSection={jest.fn()} />)

    expect(screen.queryByTestId('gateway-card')).toBeNull()
    expect(screen.queryByTestId('connection-line')).toBeNull()
    // The tab strip is still there; it is only the gateway card that went.
    expect(screen.getByTestId('tab-settings')).toBeTruthy()
  })

  it('shows a status line on a phone once the connection needs attention', () => {
    gateway.status = 'reconnecting'
    renderScreen(<BotsScreen onOpenSection={jest.fn()} />)

    expect(screen.getByTestId('connection-line')).toHaveTextContent(/Reconnecting/)
    expect(screen.queryByTestId('gateway-card')).toBeNull()
  })

  it('keeps the gateway card on the wide layout, and no line with it', () => {
    renderScreen(<BotsScreen onOpenSection={jest.fn()} variant="sidebar" />)

    expect(screen.getByTestId('gateway-card')).toBeTruthy()
    expect(screen.queryByTestId('connection-line')).toBeNull()
  })
})
