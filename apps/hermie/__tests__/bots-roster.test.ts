import { BotsController } from '../src/features/bots/bots-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, isUnread, useBotsStore } from '../src/store/bots'
import { FakeChatGateway } from './support/fake-chat-gateway'

const PROFILE_ROW = {
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  has_avatar: true,
  ui_meta_revisions: { avatar: 3, soul: 1 },
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    preview: 'Draft is ready.',
    last_active: 1_700_000_100,
    message_count: 12
  }
}

function setup() {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const controller = new BotsController({ gateway, store: useBotsStore, cache })

  return { gateway, cache, controller }
}

beforeEach(() => {
  useBotsStore.getState().reset()
})

describe('projecting a profile row', () => {
  it('keeps the durable id and the lineage tip apart', () => {
    const bot = botFromProfileRow(PROFILE_ROW)

    expect(bot.canonical).toEqual({
      id: 'stored-researcher',
      resolvedId: 'tip-researcher',
      preview: 'Draft is ready.',
      lastActive: 1_700_000_100,
      messageCount: 12
    })
  })

  it('takes the highest ui_meta revision so a changed avatar invalidates its cache', () => {
    expect(botFromProfileRow(PROFILE_ROW).uiMetaRevision).toBe(3)
  })

  it('falls back to the profile name when there is no display name', () => {
    expect(botFromProfileRow({ name: 'writer', path: '/p' }).displayName).toBe('writer')
  })
})

describe('the roster', () => {
  it('loads profiles and caches them for the next cold start', async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: true, data: 'data:image/png;base64,AAA' })

    await controller.refresh()

    expect(gateway.lastCall('profiles.list')).toEqual({ include_sessions: true })
    expect(useBotsStore.getState().bots).toHaveLength(1)
    await expect(cache.readBots()).resolves.toHaveLength(1)
  })

  it('fetches an avatar once per revision', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: true, data: 'data:image/png;base64,AAA' })

    await controller.refresh()
    await controller.loadAvatars(useBotsStore.getState().bots)

    expect(gateway.calls.filter(call => call.method === 'profiles.get_asset')).toHaveLength(1)
    expect(gateway.lastCall('profiles.get_asset')).toEqual({ name: 'researcher', asset: 'avatar' })
    expect(useBotsStore.getState().avatars.researcher).toBe('data:image/png;base64,AAA')
  })

  it('paints the cached roster before the gateway answers', async () => {
    const { cache, controller } = setup()

    await cache.writeBots([
      {
        name: 'writer',
        json: JSON.stringify(botFromProfileRow({ name: 'writer', path: '/p' })),
        avatarRev: 0,
        updatedAt: 1
      }
    ])

    await controller.paintFromCache()

    expect(useBotsStore.getState().bots.map(bot => bot.name)).toEqual(['writer'])
    // A cache paint is not a refresh: nothing has been read from the gateway.
    expect(useBotsStore.getState().refreshedAt).toBeNull()
  })

  it('marks a bot as running while its profile has a busy session', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: false })
    gateway.reply('session.active_list', { sessions: [{ status: 'working' }] })

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ researcher: true })
  })

  it('treats a bot whose active list fails as idle rather than as an error', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: false })
    gateway.reply('session.active_list', () => {
      throw new Error('backend restarting')
    })

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({})
    expect(useBotsStore.getState().error).toBeNull()
  })
})

describe('unread', () => {
  it('is set while the chat moved after the user last looked at it', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(true)

    useBotsStore.getState().markSeen('researcher')

    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(false)
  })

  it('never moves the watermark backwards', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().markSeen('researcher', 2_000)
    useBotsStore.getState().markSeen('researcher', 1_000)

    expect(useBotsStore.getState().lastSeen.researcher).toBe(2_000)
  })
})

describe('canonical chat resolution', () => {
  it('uses the roster row when the gateway already resolved it', async () => {
    const { gateway, controller } = setup()

    const canonical = await controller.resolveCanonical(botFromProfileRow(PROFILE_ROW))

    expect(canonical.id).toBe('stored-researcher')
    expect(gateway.calls).toHaveLength(0)
  })

  it('looks the chat up by exact title, including hidden sessions', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', {
      sessions: [{ id: 'stored-x', resolved_id: 'tip-x', title: 'Bot Chat', message_count: 4 }]
    })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(gateway.lastCall('session.list')).toMatchObject({
      profile: 'writer',
      title: 'Bot Chat',
      include_hidden: true
    })
    expect(canonical).toMatchObject({ id: 'stored-x', resolvedId: 'tip-x' })
    expect(gateway.methodOrder()).not.toContain('session.create')
  })

  it('re-runs the lookup before minting, so a chat created meanwhile is adopted', async () => {
    const { gateway, controller } = setup()
    let attempt = 0

    gateway.reply('session.list', () => {
      attempt += 1

      return attempt === 1 ? { sessions: [] } : { sessions: [{ id: 'stored-late', title: 'Bot Chat' }] }
    })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(canonical.id).toBe('stored-late')
    expect(gateway.methodOrder()).toEqual(['session.list', 'session.list'])
  })

  it('creates the chat hidden, titled and following the profile config', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', { sessions: [] })
    gateway.reply('session.create', { session_id: 'runtime-new', stored_session_id: 'stored-new' })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(canonical.id).toBe('stored-new')
    expect(gateway.lastCall('session.create')).toMatchObject({
      profile: 'writer',
      title: 'Bot Chat',
      hidden: true,
      source: 'hermie',
      cols: 96,
      follow_profile_config: true
    })
  })

  it('fails closed when the registry lookup errors instead of minting a second chat', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', () => {
      throw new Error('backend restarting')
    })

    await expect(controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))).rejects.toThrow(
      /not starting a new chat/
    )
    expect(gateway.methodOrder()).not.toContain('session.create')
  })

  it('resolves a bot once even when two taps land together', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', { sessions: [] })
    gateway.reply('session.create', { stored_session_id: 'stored-once' })

    const bot = botFromProfileRow({ name: 'writer', path: '/p' })
    const [first, second] = await Promise.all([controller.resolveCanonical(bot), controller.resolveCanonical(bot)])

    expect(first).toEqual(second)
    expect(gateway.calls.filter(call => call.method === 'session.create')).toHaveLength(1)
  })
})
