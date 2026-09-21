/**
 * ADR-0017's app half: what a switch does, what a tap is allowed to do, and how
 * often the heartbeat beats.
 *
 * `packages/gateway-client/src/push.test.ts` pins the BYTES. This pins the
 * behaviour around them, and the four things worth pinning are the four that can
 * go wrong quietly:
 *
 *  - **The projection, end to end.** A registration only ever reaches a gateway
 *    because `snapshotFromStores` picks it up, so the test that matters is the
 *    one that asserts the app-wide section, not the one that asserts the store.
 *  - **Every removal path.** Off, revoked outside the app, signed out, changed
 *    gateway. Three of the four are easy to implement and easy to forget, and
 *    the symptom of forgetting is a device that goes on buzzing for a gateway
 *    nobody is signed in to.
 *  - **Action validation.** ADR-0017: "a notification is a hint that something
 *    happened, never an instruction". A forged Allow must open a chat and send
 *    nothing.
 *  - **Cadence.** A heartbeat is a `profiles.configure` per beat, so the two
 *    failure modes are "too rarely to suppress anything" and "a write a second".
 */
import { pushSectionFor, pushStampOf } from '@hermie/gateway-client/push'
import type { PushAddress } from '@hermie/gateway-client/push'

import { pushTapOf, resolvePushTap, type OpenApproval } from '../src/features/push/actions'
import type { PushPermission, PushPlatform, PushResponse } from '../src/features/push/platform-contract'
import { PUSH_HEARTBEAT_MS, PushSync, type PushSyncPorts } from '../src/features/push/push-sync'
import { keyValueStore } from '../src/platform/key-value-store'
import { ownRegistration, PUSH_KEY, usePushStore } from '../src/store/push'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'

const NOW_MS = 1_789_957_143_000
const NOW = pushStampOf(NOW_MS)

const TOKEN: PushAddress = { transport: 'expo', token: 'ExponentPushToken[abc]' }

interface FakePlatform extends PushPlatform {
  responses: ((response: PushResponse) => void)[]
  dropped: number
  permissionValue: PushPermission
  addressValue: PushAddress | null
  initial: PushResponse | null
}

function fakePlatform(patch: Partial<FakePlatform> = {}): FakePlatform {
  const platform: FakePlatform = {
    available: true,
    platform: 'ios',
    responses: [],
    dropped: 0,
    permissionValue: 'granted',
    addressValue: TOKEN,
    initial: null,
    prepare: async () => undefined,
    permission: async () => platform.permissionValue,
    requestPermission: async () => platform.permissionValue,
    obtainAddress: async () => platform.addressValue,
    dropAddress: async () => {
      platform.dropped += 1
    },
    onResponse: handler => {
      platform.responses.push(handler)

      return () => {
        platform.responses = platform.responses.filter(entry => entry !== handler)
      }
    },
    consumeInitialResponse: async () => platform.initial,
    ...patch
  }

  return platform
}

function fakePorts(): PushSyncPorts & { shown: string[]; responded: [string, string, string][]; open: OpenApproval[] } {
  const ports = {
    shown: [] as string[],
    responded: [] as [string, string, string][],
    open: [] as OpenApproval[],
    showChat: async (bot: string) => {
      ports.shown.push(bot)
    },
    openApprovals: async () => ports.open,
    respondApproval: async (bot: string, requestId: string, choice: string) => {
      ports.responded.push([bot, requestId, choice])
    }
  }

  return ports
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

const syncFor = (platform: PushPlatform, ports: PushSyncPorts) =>
  new PushSync({ platform, ports, projectId: 'project', now: () => NOW_MS })

beforeEach(async () => {
  usePushStore.getState().reset()
  await keyValueStore.delete(PUSH_KEY)
})

describe('the switch', () => {
  it('registers nothing until it is turned on', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.push).toBeUndefined()
    // The dialog is what turning the switch on does. A settings screen that
    // opens one on mount is a settings screen people say no to, once, for ever.
    expect(usePushStore.getState().address).toBeNull()

    sync.stop()
  })

  it('puts this device’s row in the app-wide section once it is on', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('enabled')

    const state = usePushStore.getState()
    const app = snapshotFromStores().app as HermieAppShape
    const row = app.push?.registrations[state.installationId] as Record<string, unknown>

    expect(row).toMatchObject({ v: 1, transport: 'expo', token: 'ExponentPushToken[abc]', platform: 'ios' })
    expect(row.updatedAt).toBe(NOW)
    // The payload says who, not what, until somebody says otherwise.
    expect(row.preview).toBe(false)

    sync.stop()
  })

  it('says denied rather than pretending, when the reader refuses', async () => {
    const platform = fakePlatform({ permissionValue: 'denied' })
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('denied')
    expect(usePushStore.getState().enabled).toBe(false)
    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('stays on with no row when the platform gives no address', async () => {
    // Permission granted, no token: a simulator with no APNs registration, or a
    // build with no EAS project. The reader asked and the platform has not
    // agreed yet, which is what the switch should show.
    const platform = fakePlatform({ addressValue: null })
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()

    expect(await sync.enable()).toBe('unavailable')
    expect(usePushStore.getState().enabled).toBe(true)
    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('carries the other devices’ rows through its own write', async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()
    usePushStore.getState().applyRemote({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } },
      seen: { 'i-tablet': NOW - 10 }
    })
    await sync.enable()

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.push?.registrations['i-tablet']).toEqual({ v: 1, transport: 'expo', token: 'theirs' })
    expect(app.push?.seen['i-tablet']).toBe(NOW - 10)

    sync.stop()
  })
})

describe('every way a registration goes away', () => {
  const enabled = async () => {
    const platform = fakePlatform()
    const sync = syncFor(platform, fakePorts())

    sync.start()
    await settled()
    await sync.enable()

    return { platform, sync }
  }

  const rowCount = (): number =>
    Object.keys(((snapshotFromStores().app as HermieAppShape).push?.registrations ?? {}) as object).length

  it('removes the row when the switch goes off', async () => {
    const { sync } = await enabled()

    expect(rowCount()).toBe(1)
    await sync.disable()

    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('removes it when permission was revoked outside the app', async () => {
    const { platform, sync } = await enabled()

    // The reader turned Hermie off in system settings while the app was away.
    // A switch that still says ON is the one lie a settings screen must not
    // tell, so the foreground pass follows the system rather than arguing.
    platform.permissionValue = 'denied'
    await sync.refresh()

    expect(usePushStore.getState().enabled).toBe(false)
    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('removes it on retire, and keeps the installation id for the next sign-in', async () => {
    const { platform, sync } = await enabled()
    const id = usePushStore.getState().installationId

    await sync.retire()

    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()
    expect(usePushStore.getState().installationId).toBe(id)
    expect(platform.dropped).toBe(1)

    sync.stop()
  })

  it('drops the neighbours’ rows on retire rather than writing them to the next gateway', async () => {
    const { sync } = await enabled()

    usePushStore.getState().applyRemote({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } },
      seen: { 'i-tablet': NOW }
    })

    await sync.retire()

    // They belong to the gateway that was just left. Carrying them into the
    // next one would register somebody else's phone somewhere it never was.
    expect(usePushStore.getState().others).toEqual({})
    expect((snapshotFromStores().app as HermieAppShape).push).toBeUndefined()

    sync.stop()
  })

  it('re-stamps rather than re-registering when the token has not changed', async () => {
    const { sync } = await enabled()
    const before = usePushStore.getState().updatedAt

    await sync.refresh()

    expect(usePushStore.getState().updatedAt).toBe(before)
    expect(rowCount()).toBe(1)

    sync.stop()
  })
})

describe('the heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const started = () => {
    const sync = new PushSync({
      platform: fakePlatform(),
      ports: fakePorts(),
      now: () => NOW_MS,
      heartbeatMs: 1_000
    })

    sync.start()

    return sync
  }

  it('beats immediately when a chat comes on screen', () => {
    const sync = started()

    void usePushStore.getState().hydrate()
    jest.advanceTimersByTime(0)

    sync.setOpenChat('researcher')

    const id = usePushStore.getState().installationId

    expect(usePushStore.getState().seen[id]).toBe(NOW)

    sync.stop()
  })

  it('does not beat with no chat open, or in the background', () => {
    const sync = started()

    jest.advanceTimersByTime(10_000)
    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    sync.setForeground(false)
    sync.setOpenChat('researcher')
    jest.advanceTimersByTime(10_000)

    // A window behind another window is not somebody reading a chat.
    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    sync.stop()
  })

  it('beats on the cadence and no faster', () => {
    const sync = started()
    const beats: number[] = []
    const unsubscribe = usePushStore.subscribe(state => beats.push(Object.keys(state.seen).length))

    void usePushStore.getState().hydrate()
    jest.advanceTimersByTime(0)
    sync.setOpenChat('researcher')

    const after = beats.length

    jest.advanceTimersByTime(3_500)

    // Three periods in 3.5 seconds, and not one per timer tick.
    expect(beats.length - after).toBe(3)

    unsubscribe()
    sync.stop()
  })

  it('stops when the chat closes and starts again when one opens', () => {
    const sync = started()

    void usePushStore.getState().hydrate()
    jest.advanceTimersByTime(0)

    sync.setOpenChat('researcher')
    sync.setOpenChat(null)

    const quiet = usePushStore.getState().seen

    jest.advanceTimersByTime(5_000)
    expect(usePushStore.getState().seen).toBe(quiet)

    sync.setOpenChat('writer')
    expect(usePushStore.getState().seen).not.toBe(quiet)

    sync.stop()
  })

  it('beats once the store has hydrated, for a chat that opened before it did', async () => {
    // The launch-straight-onto-a-chat case, measured on a simulator on
    // 2026-09-21: the registration reached the gateway and `seen` stayed empty
    // for a full period, because the first beat had no installation id to key
    // itself by and nothing asked again until the interval came round.
    jest.useRealTimers()

    const sync = new PushSync({ platform: fakePlatform(), ports: fakePorts(), now: () => NOW_MS })

    sync.setOpenChat('researcher')
    sync.start()

    expect(Object.keys(usePushStore.getState().seen)).toHaveLength(0)

    await settled()

    const id = usePushStore.getState().installationId

    expect(usePushStore.getState().seen[id]).toBe(NOW)

    sync.stop()
    jest.useFakeTimers()
  })

  it('has a default cadence measured in tens of seconds, not seconds', () => {
    // A write a second from a device somebody is reading on would be a
    // `profiles.configure` a second. The daemon's suppression window is much
    // wider than this, so the freshness is free.
    expect(PUSH_HEARTBEAT_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('what a tap may do', () => {
  const response = (data: Record<string, unknown>, actionIdentifier = 'default'): PushResponse => ({
    actionIdentifier,
    data
  })

  it('reads a bot out of a payload and nothing else', () => {
    expect(pushTapOf(response({ bot: 'researcher', type: 'message' }))).toEqual({
      bot: 'researcher',
      requestId: '',
      action: 'open'
    })
    expect(pushTapOf(response({ type: 'message' }))).toBeNull()
  })

  it('degrades an Allow that names no request to opening the chat', () => {
    expect(pushTapOf(response({ bot: 'researcher' }, 'allow'))).toEqual({
      bot: 'researcher',
      requestId: '',
      action: 'open'
    })
  })

  it('answers only a request the gateway still says is open', () => {
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'allow' as const }
    const open: OpenApproval[] = [{ request_id: 'req-1', choices: ['once', 'session', 'always', 'deny'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({
      kind: 'respond',
      bot: 'researcher',
      requestId: 'req-1',
      choice: 'once'
    })
  })

  it('never widens the grant beyond this one run', () => {
    // A button on a lock screen is the least considered decision of the day.
    // `session` and `always` are on the sheet, where the command is in front of
    // the reader, and nowhere else.
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'allow' as const }
    const open: OpenApproval[] = [{ request_id: 'req-1', choices: ['session', 'always'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })

  it('opens the chat when the request has already been answered elsewhere', () => {
    const tap = { bot: 'researcher', requestId: 'req-1', action: 'deny' as const }

    expect(resolvePushTap({ tap, pending: [] })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })

  it('opens the chat for a request id the payload made up', () => {
    const tap = { bot: 'researcher', requestId: 'req-forged', action: 'allow' as const }
    const open: OpenApproval[] = [{ request_id: 'req-real', choices: ['once', 'deny'] }]

    expect(resolvePushTap({ tap, pending: open })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })
})

describe('a tap, end to end', () => {
  it('opens the chat and sends nothing for a plain notification', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({ actionIdentifier: 'default', data: { bot: 'researcher', type: 'message' } })
    await settled()

    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([])

    sync.stop()
  })

  it('opens the chat FIRST, then answers, for an Allow', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()

    ports.open = [{ request_id: 'req-1', choices: ['once', 'deny'] }]

    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'allow',
      data: { bot: 'researcher', type: 'request', requestId: 'req-1' }
    })
    await settled()

    // The chat has to be resumed before `approval.pending` has a session to ask
    // about, so the order is load-bearing rather than cosmetic.
    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([['researcher', 'req-1', 'once']])

    sync.stop()
  })

  it('sends nothing for a forged Allow, and still opens the chat', async () => {
    const platform = fakePlatform()
    const ports = fakePorts()
    const sync = syncFor(platform, ports)

    sync.start()
    await settled()

    platform.responses[0]?.({
      actionIdentifier: 'allow',
      data: { bot: 'researcher', type: 'request', requestId: 'rm -rf /' }
    })
    await settled()

    expect(ports.shown).toEqual(['researcher'])
    expect(ports.responded).toEqual([])

    sync.stop()
  })

  it('acts on the notification that started the process, once', async () => {
    const platform = fakePlatform({ initial: { actionIdentifier: 'default', data: { bot: 'writer' } } })
    const ports = fakePorts()
    const first = syncFor(platform, ports)

    first.start()
    await settled()
    first.stop()

    // `consumeInitialResponse` answering the same launch tap twice is what would
    // reopen that chat on every remount; the platform consumes it, so a second
    // sync sees nothing.
    platform.initial = null

    const second = syncFor(platform, ports)

    second.start()
    await settled()
    second.stop()

    expect(ports.shown).toEqual(['writer'])
  })
})

describe('the row the store builds', () => {
  it('is null until the store has been hydrated', () => {
    const state = { ...usePushStore.getState(), enabled: true, address: TOKEN, loaded: false }

    // Before hydrate there is no installation id, and a row keyed by an empty
    // string is a row the daemon drops.
    expect(ownRegistration(state, 'ios')).toBeNull()
  })

  it('round-trips the reader’s preferences and omits nothing the daemon reads', async () => {
    await usePushStore.getState().hydrate()
    usePushStore.getState().setEnabled(true)
    usePushStore.getState().setType('cron', false)
    usePushStore.getState().setPreview(true)
    usePushStore.getState().setAddress(TOKEN, NOW)

    const own = ownRegistration(usePushStore.getState(), 'android')
    const section = pushSectionFor({ others: {}, own, seen: {}, now: NOW })
    const row = section?.registrations[usePushStore.getState().installationId] as Record<string, unknown>

    expect(row).toMatchObject({ platform: 'android', preview: true })
    expect(row.types).toEqual({ message: true, request: true, dm: true, cron: false })
  })
})
