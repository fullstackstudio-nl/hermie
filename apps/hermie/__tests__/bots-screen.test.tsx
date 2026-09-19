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
