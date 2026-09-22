/**
 * The chat's (…) menu, and the one thing it exists to stop doing.
 *
 * The owner's report was not "the sheet is ugly", it was **"nu schuift alles"** —
 * everything moves. So the assertion that matters most here is not that a
 * popover appears: it is that the transcript's own content inset is the SAME
 * NUMBER with the popover open as without it. Every other test in this file
 * would still pass if opening the menu quietly re-padded the list, which is
 * exactly the failure being fixed.
 *
 * The rest is the contract around it: a column too narrow for a popover still
 * gets the sheet (decided by MEASUREMENT, not by `Platform.OS`), a tap outside
 * and Escape both close it, and a row that leads to a page hands over to the
 * sheet already on that page rather than dropping the reader at the root.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { usePushStore } from '../src/store/push'
import { useSettingsStore } from '../src/store/settings'
import { nextFocus, popoverRows } from '../src/ui/sheets'
import { renderScreen } from './support/render'

/**
 * The backdrop is hidden FROM ACCESSIBILITY on purpose — it is a tap target and
 * not a control — so a query has to say it wants hidden elements too.
 */
const HIDDEN = { includeHiddenElements: true } as const

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: { refresh: jest.Mock }
  push: { setOpenChat: jest.Mock }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

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
    editQueued: jest.fn(() => ''),
    deleteQueued: jest.fn(),
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => ({ items: [] })),
    knowsSlashCommand: jest.fn(() => false),
    runSlash: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    refreshUsage: jest.fn(async () => null),
    modelOptions: jest.fn(async () => [])
  }
}

function seedChat() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  usePushStore.getState().reset()
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

beforeEach(() => {
  mockController = makeController()
  mockRuntime = {
    bots: { refresh: jest.fn(async () => undefined) },
    controller: mockController,
    push: { setOpenChat: jest.fn() }
  }
  seedChat()
})

/** Lay the floating chrome out at a given column width, the way a window would. */
function layOutChrome(width: number) {
  act(() => {
    fireEvent(screen.getByTestId('chat-chrome'), 'layout', {
      nativeEvent: { layout: { height: 72, width, x: 0, y: 0 } }
    })
  })
}

/** The inset the transcript pads its own content by. */
function contentInset(): unknown {
  const list = screen.getByTestId('transcript-list-scroll')

  return JSON.stringify(list.props.contentContainerStyle)
}

async function openChat(width = 720) {
  renderScreen(<ChatScreen bot="researcher" />)
  await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())
  layOutChrome(width)
}

describe('the options menu is a popover in the chat', () => {
  it('opens under the header without moving anything behind it', async () => {
    await openChat()

    const before = contentInset()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    // The whole of the owner's request, in one comparison: the list pads its
    // content by the same number it did before the menu opened.
    expect(contentInset()).toBe(before)
    // And it really is a popover rather than the sheet under another name.
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('still offers the sheet on a column too narrow for a popover', async () => {
    await openChat(360)

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    expect(screen.queryByTestId('chat-options-popover')).toBeNull()
  })

  it('takes the sheet before the column has been measured, rather than guessing', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
  })

  it('closes on a tap anywhere else', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('chat-options-backdrop', HIDDEN))

    await waitFor(() => expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull())
  })

  it('answers a toggle in place, without opening anything', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-thinking'))

    expect(useSettingsStore.getState().perChat.researcher?.showThinking).toBe(true)
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('hands a page over to the sheet, already on that page', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-model'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    // The model page, not the root: `picker-search` is the model picker's own
    // field and the root has no field at all.
    expect(screen.getByTestId('picker-search')).toBeTruthy()
    expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull()
  })
})

describe('refreshing a chat after a gateway restart', () => {
  it('re-reads the roster and re-opens the chat, and closes the menu', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-refresh')).toBeTruthy())

    mockController.openChat.mockClear()

    fireEvent.press(screen.getByTestId('option-refresh'))

    // The roster is where the canonical session id comes from, and after a
    // restart it is the one that has to be asked again.
    await waitFor(() => expect(mockRuntime.bots.refresh).toHaveBeenCalled())
    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    // The reader wants the transcript, not the menu they just pressed.
    expect(screen.queryByTestId('chat-options-backdrop', HIDDEN)).toBeNull()
  })
})

describe('per-chat notification types', () => {
  it('are not offered at all where nothing would read them', async () => {
    await openChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-popover')).toBeTruthy())

    // This device has never asked to be told anything, so there is nothing for
    // these switches to modify.
    expect(screen.queryByTestId('option-notifications')).toBeNull()
  })

  it('open as a page of the sheet, and write the chat’s own override', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-notifications'))

    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    // Switching one on turns every type on by default, so this one is a change.
    fireEvent.press(screen.getByTestId('option-notify-cron'))

    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false })
  })

  it('lists the six events a reader would answer differently per bot, and never `message`', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-notifications'))

    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    for (const type of ['turn_done', 'turn_failed', 'request', 'cron', 'cron_done', 'cron_failed']) {
      expect(screen.getByTestId(`option-notify-${type}`)).toBeTruthy()
    }

    // `message` is mute's domain. A second switch for it here would be two
    // controls for one decision, and they would disagree.
    expect(screen.queryByTestId('option-notify-message')).toBeNull()
  })

  it('lets a chat keep its failures while losing its chatter', async () => {
    await openChat()

    act(() => {
      usePushStore.getState().setEnabled(true)
    })

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-notifications')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-notifications'))
    await waitFor(() => expect(screen.getByTestId('option-notify-cron')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-notify-cron'))
    fireEvent.press(screen.getByTestId('option-notify-cron_done'))

    // Partial on purpose: `cron_failed` is not written, so it follows the
    // global switch as the global switch moves — which is the whole reason the
    // two outcomes are separate types.
    expect(usePushStore.getState().perBot.researcher).toEqual({ cron: false, cron_done: false })
  })
})

describe('the rows the keyboard walks', () => {
  it('are the same list the popover draws, export included only when there is one', () => {
    expect(popoverRows({ canExport: true, canRefresh: true, canSetNotifications: true }).map(row => row.id)).toEqual([
      'yolo',
      'fast',
      'reasoning',
      'model',
      'colour',
      'mute',
      'refresh',
      'notifications',
      'verbosity',
      'bot-to-bot',
      'thinking',
      'text-size',
      'export'
    ])

    expect(popoverRows({ canExport: false, canSetNotifications: false }).some(row => row.id === 'export')).toBe(false)
    expect(popoverRows({ canExport: true, canSetNotifications: false }).some(row => row.id === 'notifications')).toBe(
      false
    )
  })

  it('clamps rather than wrapping, so the end of the list says it is the end', () => {
    expect(nextFocus(0, -1, 5)).toBe(0)
    expect(nextFocus(4, 1, 5)).toBe(4)
    expect(nextFocus(2, 1, 5)).toBe(3)
    expect(nextFocus(0, 1, 0)).toBe(0)
  })
})
