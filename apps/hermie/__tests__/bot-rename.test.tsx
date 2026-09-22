/**
 * Renaming a bot: the call, the field that makes it, and the keys it moves.
 *
 * Three things are worth asserting and they are three different failures:
 *
 *  - **The field says which name it is editing.** `PATCH /api/profiles/{name}`
 *    sets a display name on `default` and genuinely RENAMES every other
 *    profile, so a sheet that labelled both "Display name" would have somebody
 *    change a handle their crons address and never be told.
 *  - **The stores are rekeyed.** A bot's name is this app's primary key. If the
 *    gateway renames a profile and nothing local moves, the next roster read
 *    drops the colour, the folder, the note, the watermark and the cached
 *    transcript — silently, because a missing key reads as a new bot.
 *  - **A refusal stays a refusal.** 400 and 404 are the two the route answers,
 *    and neither may be reported as a success or leave the stores half moved.
 */
import { createChatState } from '@hermie/transcript'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import type { GatewayHttp } from '@hermie/gateway-client'

import { BotProfileSheet } from '../src/features/bot-profile'
import { initialBotName, renameBot, renameProfile, ProfileRenameError } from '../src/features/bot-rename'
import type { ChatGateway } from '../src/gateway/link'
import { type ChatCache, chatCacheFor } from '../src/platform/chat-cache'
import { useBotsStore, type Bot } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { useDeviceContextStore } from '../src/store/device-context'
import { renderScreen } from './support/render'

/*
  The real cache opens SQLite (or IndexedDB) on first use, which a test process
  has neither of. The in-memory implementation is the same contract, which is
  the whole reason `chat-cache-core.ts` exists.
*/
jest.mock('../src/platform/chat-cache', () => {
  const core = jest.requireActual('../src/platform/chat-cache-core')
  const caches = new Map<string, unknown>()

  // One per gateway, memoised exactly as the real module memoises: `renameBot`
  // asks for the cache by id, and a second instance would answer an empty one.
  return {
    ...core,
    chatCacheFor: (gatewayId: string) => {
      if (!caches.has(gatewayId)) {
        caches.set(gatewayId, new core.MemoryChatCache())
      }

      return caches.get(gatewayId)
    }
  }
})

/** The gateway the rename is happening on. One is enough to key a cache by. */
const GATEWAY = 'gaaaaaaaaaaaaaaaa'

const cache = (): ChatCache => chatCacheFor(GATEWAY)

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Reads things so you do not have to.',
  model: 'claude-sonnet-4-6-20251001',
  provider: 'anthropic',
  isDefault: false,
  hasAvatar: false,
  canonical: { id: 'sess-7', resolvedId: 'sess-7', preview: '', lastActive: 0, messageCount: 0 },
  uiMetaRevision: 3
}

const DEFAULT_BOT: Bot = { ...BOT, name: 'default', displayName: 'default', isDefault: true }

/** A gateway that answers the two socket calls the sheet may make. */
function fakeGateway(): ChatGateway {
  return {
    request: jest.fn(async () => ({ ok: true, applied: { description: true } })),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    fetchMessages: async () => null
  } as unknown as ChatGateway
}

/** The REST half, recorded. `patch` is the only verb this feature uses. */
function fakeHttp(answer: unknown | (() => never)) {
  const calls: { path: string; body: unknown }[] = []

  const http = {
    patch: jest.fn(async (path: string, body: unknown) => {
      calls.push({ path, body })

      if (typeof answer === 'function') {
        return (answer as () => never)()
      }

      return answer
    })
  } as unknown as GatewayHttp

  return { http, calls }
}

function sheet(bot: Bot, http: GatewayHttp | null, onSaved?: () => void) {
  return renderScreen(
    <BotProfileSheet
      bot={bot}
      gateway={fakeGateway()}
      gatewayVersion="0.21.3"
      onClose={() => undefined}
      visible
      {...(http ? { http } : {})}
      {...(onSaved ? { onSaved } : {})}
    />
  )
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useDeviceContextStore.getState().reset()
})

// -- which name the field is editing -----------------------------------------

describe('the name field', () => {
  it('edits the DISPLAY name on the default profile, and warns about nothing', () => {
    sheet(DEFAULT_BOT, fakeHttp({ ok: true, name: 'default', display_name: 'X', path: '/p' }).http)

    expect(screen.getByTestId('bot-profile-name')).toBeTruthy()
    expect(screen.queryByTestId('bot-profile-name-warning')).toBeNull()
  })

  it('edits the PROFILE name on any other profile, and says what that costs', () => {
    sheet(BOT, fakeHttp({ ok: true, name: 'analyst', path: '/p' }).http)

    expect(screen.getByTestId('bot-profile-name-warning')).toHaveTextContent(
      'Renaming changes the profile name other tools use'
    )
  })

  /** A roster row with no display name is projected as the id; that is not a label. */
  it('starts empty on a default profile that has never been given a label', () => {
    expect(initialBotName({ name: 'default', displayName: 'default', isDefault: true })).toBe('')
    expect(initialBotName({ name: 'default', displayName: 'Jurist', isDefault: true })).toBe('Jurist')
    expect(initialBotName({ name: 'researcher', displayName: 'Researcher', isDefault: false })).toBe('researcher')
  })

  /** Without a REST half there is nothing that can rename, so the rows go back to facts. */
  it('is read-only when the connection has no REST surface', () => {
    sheet(BOT, null)

    expect(screen.queryByTestId('bot-profile-name')).toBeNull()
  })
})

// -- the call ----------------------------------------------------------------

describe('saving the name', () => {
  it('sends new_name to PATCH /api/profiles/{name} and nothing else', async () => {
    const { http, calls } = fakeHttp({ ok: true, name: 'analyst', path: '/root/.hermes/profiles/analyst' })
    const onSaved = jest.fn()

    sheet(BOT, http, onSaved)
    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'analyst')
    fireEvent.press(screen.getByTestId('bot-profile-save'))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ path: '/api/profiles/researcher', body: { new_name: 'analyst' } })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('shows a 400 beside the field instead of closing', async () => {
    const { GatewayError } = jest.requireActual('@hermie/gateway-client')
    const { http } = fakeHttp(() => {
      throw new GatewayError('protocol', 'PATCH failed with HTTP 400.', { status: 400 })
    })

    sheet(BOT, http)
    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'analyst')
    fireEvent.press(screen.getByTestId('bot-profile-save'))

    await waitFor(() => expect(screen.getByTestId('bot-profile-error')).toHaveTextContent(/would not take that name/))
  })

  it('shows a 404 as a missing profile rather than as a missing endpoint', async () => {
    const { GatewayError } = jest.requireActual('@hermie/gateway-client')
    const { http } = fakeHttp(() => {
      throw new GatewayError('protocol', 'The gateway has no PATCH /api/profiles/researcher endpoint.', {
        status: 404
      })
    })

    sheet(BOT, http)
    fireEvent.changeText(screen.getByTestId('bot-profile-name'), 'analyst')
    fireEvent.press(screen.getByTestId('bot-profile-save'))

    await waitFor(() =>
      expect(screen.getByTestId('bot-profile-error')).toHaveTextContent('The gateway has no profile called researcher.')
    )
  })

  /** `rename_profile` refuses it before the setter sees it, so the app does too. */
  it('refuses to clear the default profile without asking the gateway', async () => {
    const { http, calls } = fakeHttp({ ok: true })

    await expect(renameProfile(http, 'default', '   ')).rejects.toBeInstanceOf(ProfileRenameError)
    expect(calls).toHaveLength(0)
  })

  it('reads a display-name answer as a label and NOT as a rename', async () => {
    const { http } = fakeHttp({ ok: true, name: 'default', display_name: 'Jurist', path: '/root/.hermes' })
    const answer = await renameProfile(http, 'default', 'Jurist')

    expect(answer).toEqual({ name: 'default', displayName: 'Jurist', path: '/root/.hermes', renamed: false })
  })

  it('reads an answer without a display name as a real rename', async () => {
    const { http } = fakeHttp({ ok: true, name: 'analyst', path: '/root/.hermes/profiles/analyst' })
    const answer = await renameProfile(http, 'researcher', 'analyst')

    expect(answer.renamed).toBe(true)
    expect(answer.displayName).toBeNull()
  })
})

// -- the keys ----------------------------------------------------------------

describe('renameBot', () => {
  async function seed(): Promise<void> {
    useBotsStore.getState().setBots([BOT])
    useBotsStore.getState().markSeen('researcher', 400)
    useChatsStore.getState().hydrate('researcher', createChatState('researcher', 'sess-7', 'sess-7'))
    useChatsStore.getState().bindRuntime('researcher', 'runtime-1')
    useChatsStore.getState().markLive('researcher')
    useChatLayoutStore.getState().reconcile(['researcher'])
    useChatLayoutStore.getState().setAccent('researcher', 'lime')
    useChatLayoutStore.getState().setArchived('researcher', true)
    useChatLayoutStore.getState().setMute('researcher', 0)
    useDeviceContextStore.getState().setBotNote('researcher', 'Prefers footnotes.', 10)
    await cache().write({
      bot: 'researcher',
      itemsJson: '[]',
      lastRowId: 9,
      lastSeq: 4,
      epoch: 'e1',
      updatedAt: 1
    })
  }

  it('moves every key the app holds a bot under', async () => {
    await seed()

    const result = await act(async () => renameBot('researcher', 'analyst', GATEWAY))

    expect(result).toEqual({ ok: true, failed: [] })

    const bots = useBotsStore.getState()
    const chats = useChatsStore.getState()
    const layout = useChatLayoutStore.getState()

    expect(bots.byName.analyst?.name).toBe('analyst')
    expect(bots.byName.researcher).toBeUndefined()
    expect(bots.lastSeen.analyst).toBe(400)

    expect(chats.chats.analyst?.botName).toBe('analyst')
    expect(chats.chats.researcher).toBeUndefined()
    expect(chats.botForRuntime('runtime-1')).toBe('analyst')
    expect(chats.live.analyst).toBe(true)

    expect(layout.entries).toContainEqual({ kind: 'chat', name: 'analyst' })
    expect(layout.entries).not.toContainEqual({ kind: 'chat', name: 'researcher' })
    expect(layout.accents.analyst).toBe('lime')
    expect(layout.accents.researcher).toBeUndefined()
    expect(layout.archived.analyst).toBe(true)
    expect(layout.mutes.analyst).toBe(0)
    expect(useDeviceContextStore.getState().perBot).toEqual({ analyst: 'Prefers footnotes.' })

    expect((await cache().read('analyst'))?.lastRowId).toBe(9)
    expect(await cache().read('researcher')).toBeNull()
  })

  it('moves a bot inside a folder with the folder', async () => {
    await seed()
    useChatLayoutStore.getState().addFolderAround('researcher', 'Work')

    await act(async () => renameBot('researcher', 'analyst', GATEWAY))

    expect(useChatLayoutStore.getState().folders[0]?.bots).toEqual(['analyst'])
  })

  /** The `default` profile keeps its id, so there is nothing to move. */
  it('does nothing when the name did not actually change', async () => {
    await seed()

    expect(await renameBot('researcher', 'researcher', GATEWAY)).toEqual({ ok: true, failed: [] })
    expect(useChatsStore.getState().chats.researcher).toBeTruthy()
  })
})
