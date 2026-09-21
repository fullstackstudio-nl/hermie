/**
 * Where a chat says its connection is down, and what it offers while it is.
 *
 * The reported defect is the reason the first half of this file is about
 * PLACEMENT rather than about wording: the notice was a bar at the top of the
 * transcript pane, the floating chrome covers that pane's top, and what a reader
 * actually saw was half a sentence sliding out from behind the contact pill.
 *
 * So the assertions are: the top-edge bar is gone; an empty chat gets a plate in
 * the middle; a chat with something to read gets a pill over the composer and
 * keeps every row it had; and `Try now` is withheld until a reconnect has been
 * going on long enough to be worth interrupting.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'

import { connectionNotice, RETRY_OFFER_MS } from '../src/features/chats/connection-notice'
import { ChatScreen } from '../src/features/chats/ChatScreen'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

describe('which notice a connection has earned', () => {
  const base = { blocked: false, hasTranscript: false, waitingMs: 0 } as const

  it('says nothing at all on a live connection', () => {
    expect(connectionNotice({ ...base, status: 'ready' }).kind).toBe('none')
  })

  it('says nothing while the app is in the background', () => {
    // `paused` is the connection stopping on purpose. "Reconnecting…" drawn over
    // a chat the reader is about to come back to is a lie about the last frame.
    expect(connectionNotice({ ...base, status: 'paused' }).kind).toBe('none')
  })

  it('stands down for a refusal that has its own banner and its own button', () => {
    // Signed out, an incompatible gateway, a host guard. Two notices about one
    // connection is how a screen stops being read.
    expect(connectionNotice({ ...base, blocked: true, status: 'reconnecting' }).kind).toBe('none')
  })

  it('fills an empty chat and only interrupts a full one', () => {
    expect(connectionNotice({ ...base, status: 'connecting' }).kind).toBe('empty')
    expect(connectionNotice({ ...base, hasTranscript: true, status: 'connecting' }).kind).toBe('pill')
  })

  it('keeps the three words apart, because they are three different facts', () => {
    expect(connectionNotice({ ...base, status: 'connecting' }).phase).toBe('connecting')
    expect(connectionNotice({ ...base, status: 'probing' }).phase).toBe('connecting')
    expect(connectionNotice({ ...base, status: 'authenticating' }).phase).toBe('connecting')
    expect(connectionNotice({ ...base, status: 'reconnecting' }).phase).toBe('reconnecting')
    expect(connectionNotice({ ...base, status: 'offline' }).phase).toBe('offline')
  })

  it('withholds Try now until the ladder has climbed far enough to be worth resetting', () => {
    expect(connectionNotice({ ...base, status: 'reconnecting', waitingMs: RETRY_OFFER_MS }).retry).toBe(false)
    expect(connectionNotice({ ...base, status: 'reconnecting', waitingMs: RETRY_OFFER_MS + 1 }).retry).toBe(true)
  })

  it('does not offer it on a first connect, which has no ladder to reset', () => {
    expect(connectionNotice({ ...base, status: 'connecting', waitingMs: 60_000 }).retry).toBe(false)
  })
})

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

let mockStatus = 'reconnecting'
const mockRetryNow = jest.fn()

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    config: { baseUrl: 'https://gateway.example.com' },
    connection: { retryNow: mockRetryNow },
    http: null,
    status: mockStatus
  })
}))

const mockController = {
  openChat: jest.fn(async () => undefined),
  closeChat: jest.fn(async () => undefined),
  refreshOptions: jest.fn(async () => undefined),
  modelOptions: jest.fn(async () => [])
}

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => ({ controller: mockController, bots: {}, push: { setOpenChat: jest.fn() } })
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

describe('a chat whose gateway is away', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useBotsStore.getState().reset()
    useChatsStore.getState().reset()
    useSettingsStore.getState().reset()
    useBotsStore.getState().setBots([BOT])
    mockRetryNow.mockClear()
    mockStatus = 'reconnecting'
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const render = () => renderScreen(<ChatScreen bot="researcher" />)

  it('puts nothing at the top edge, where the header would cut it in half', () => {
    render()

    expect(screen.getByTestId('chat-connecting-state')).toBeTruthy()
    // The bar that used to carry this. Its top IS the pane's top, which the
    // floating chrome sits on.
    expect(screen.queryByTestId('chat-waiting-for-connection')).toBeNull()
  })

  it('draws the bot, not the socket, on a chat that has nothing cached', () => {
    render()

    expect(screen.getByTestId('chat-connecting-state')).toBeTruthy()
    // The bot's own name, under its disc — the header carries the other one.
    expect(screen.getAllByText('Researcher').length).toBeGreaterThan(1)
    expect(screen.getAllByText('Reconnecting…').length).toBeGreaterThan(0)
    // Something is happening, and the plate says so without claiming more.
    expect(screen.getByTestId('chat-connecting-state-activity')).toBeTruthy()
  })

  it('does not spin while it is offline, because nothing is turning', () => {
    mockStatus = 'offline'
    render()

    expect(screen.getByTestId('chat-connecting-state')).toBeTruthy()
    expect(screen.queryByTestId('chat-connecting-state-activity')).toBeNull()
  })

  it('offers Try now only once the reconnect has run long enough, and dials on it', () => {
    render()

    expect(screen.queryByTestId('chat-connecting-state-retry')).toBeNull()

    act(() => {
      jest.advanceTimersByTime(RETRY_OFFER_MS + 50)
    })

    fireEvent.press(screen.getByTestId('chat-connecting-state-retry'))

    expect(mockRetryNow).toHaveBeenCalledTimes(1)
  })

  it('dims the send button while there is nowhere to send to', () => {
    render()

    // Usable: the draft is worth keeping, and writing it is the reason to sit
    // through a reconnect at all.
    act(() => {
      fireEvent.changeText(screen.getByTestId('composer-input'), 'ready when you are')
    })

    expect(screen.getByTestId('composer-send').props.accessibilityState?.disabled).toBe(true)
  })
})

describe('a chat that has something to read', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useBotsStore.getState().reset()
    useChatsStore.getState().reset()
    useSettingsStore.getState().reset()
    useBotsStore.getState().setBots([BOT])
    mockRetryNow.mockClear()
    mockStatus = 'reconnecting'

    const chats = useChatsStore.getState()

    chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
    chats.bindRuntime('researcher', 'runtime-1')
    chats.dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { message_id: 'a1', text: 'The cached copy is still readable.' }
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('leaves the pane alone and says it over the composer instead', () => {
    renderScreen(<ChatScreen bot="researcher" />)

    expect(screen.getByTestId('chat-reconnect-pill')).toBeTruthy()
    // Nothing has taken the transcript's place, and the row is still there.
    expect(screen.queryByTestId('chat-connecting-state')).toBeNull()
    expect(screen.getByText('The cached copy is still readable.')).toBeTruthy()
  })
})
