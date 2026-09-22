/**
 * The chat list's header on a sidebar that cannot hold it.
 *
 * Four incompressible controls — Boards, New bot, `+`, Edit — sat beside a
 * `flex: 1` title, and at `SIDEBAR_WIDTH_NARROW` (300pt, which is what an iPad
 * gets in portrait) there was nothing left for the title: "Chats" wrapped to one
 * character per line and "New bot…" truncated mid-word.
 *
 * Two fixes and therefore two things asserted. The title takes one line, always,
 * because eliding a word is a better failure than stacking its letters. And
 * under the threshold the three WORD actions fold into one `…`, while `+` stays
 * where it is: it is the one control here that makes something, and burying a
 * screen's primary action to make room for its title is the wrong trade.
 *
 * Width is delivered through `onLayout` rather than by rendering at a real size,
 * because nothing in this environment lays anything out — every measurement is
 * zero unless a test provides one. That is also what the component believes in
 * production, so the two agree.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots'
import { strings } from '../src/i18n/strings'
import { kanbanStrings } from '../src/features/kanban'
import { profileStrings } from '../src/features/profiles/strings'
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_NARROW } from '../src/ui/tokens'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

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

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => null }))

const ROSTER: Bot[] = [
  {
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Finds things out.',
    model: 'example-provider/example-model',
    provider: 'example-provider',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0
  }
]

/** The header row, and the width the shell would have given it. */
function layOutHeadAt(width: number) {
  fireEvent(screen.getByTestId('bots-head'), 'layout', { nativeEvent: { layout: { width, height: 60 } } })
}

beforeEach(() => {
  useBotsStore.setState({ bots: ROSTER, running: {}, lastSeen: {} })
  useChatsStore.setState({ chats: {} })
  useChatLayoutStore.setState({ layouts: {} })
})

describe('the header at the narrow sidebar width', () => {
  it('folds Boards, New bot and Edit into one overflow control, and keeps +', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)

    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()
    expect(screen.getByTestId('bots-new-cron')).toBeTruthy()

    expect(screen.queryByTestId('bots-boards')).toBeNull()
    expect(screen.queryByTestId('bots-new-bot')).toBeNull()
    expect(screen.queryByTestId('bots-edit')).toBeNull()
  })

  it('draws the title on one line, so "Chats" cannot stack its letters', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)

    // By ROLE, not by text: "Chats" is also the tab, and the assertion is about
    // the one that is this screen's heading.
    expect(screen.getByRole('header', { name: strings.bots.title }).props.numberOfLines).toBe(1)
  })

  it('offers all three actions once the overflow control is opened', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)
    fireEvent.press(screen.getByTestId('bots-head-overflow'))

    expect(screen.getByTestId('bots-head-overflow-boards')).toHaveTextContent(kanbanStrings.menu)
    expect(screen.getByTestId('bots-head-overflow-new-bot')).toHaveTextContent(profileStrings.settings.newBot)
    expect(screen.getByTestId('bots-head-overflow-edit')).toHaveTextContent(strings.layout.edit)
  })

  it('still toggles Edit from behind the overflow control', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)
    fireEvent.press(screen.getByTestId('bots-head-overflow'))
    fireEvent.press(screen.getByTestId('bots-head-overflow-edit'))

    // The menu closes behind the action, and the row now offers Done.
    fireEvent.press(screen.getByTestId('bots-head-overflow'))
    expect(screen.getByTestId('bots-head-overflow-edit')).toHaveTextContent(strings.layout.done)
  })
})

describe('the header at a width that fits', () => {
  it('keeps every action inline at the wide sidebar width, with no overflow control', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH)

    expect(screen.getByTestId('bots-boards')).toBeTruthy()
    expect(screen.getByTestId('bots-new-bot')).toBeTruthy()
    expect(screen.getByTestId('bots-new-cron')).toBeTruthy()
    expect(screen.getByTestId('bots-edit')).toBeTruthy()
    expect(screen.queryByTestId('bots-head-overflow')).toBeNull()
  })

  it('keeps them inline on a phone, which is wider than the narrow sidebar', () => {
    renderScreen(<BotsScreen onOpenSection={jest.fn()} />)

    layOutHeadAt(390)

    expect(screen.getByTestId('bots-edit')).toBeTruthy()
    expect(screen.queryByTestId('bots-head-overflow')).toBeNull()
  })

  it('goes back to one row when a window that was narrow is widened', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)
    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()

    layOutHeadAt(SIDEBAR_WIDTH)
    expect(screen.queryByTestId('bots-head-overflow')).toBeNull()
    expect(screen.getByTestId('bots-edit')).toBeTruthy()
  })
})
