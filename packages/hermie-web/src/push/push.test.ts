/**
 * The two halves of push that can be tested without a device: what comes off
 * the gateway, and what goes to Expo.
 *
 * Both are readers of somebody else's JSON, so most of these cases are about
 * refusing rather than accepting — a registration that cannot be addressed, a
 * batch that failed for the network's reasons and therefore proves nothing
 * about any token in it.
 */
import { describe, expect, it, vi } from 'vitest'

import { EXPO_RECEIPTS_URL, EXPO_SEND_URL, readExpoReceipts, sendExpo, type PushMessage } from './expo'
import {
  PUSH_SECTION_VERSION,
  pushRegistrationOf,
  readPushSection,
  registrationsFor,
  someoneAttached,
  type PushRegistration
} from './registrations'

const expoRow = (over: Record<string, unknown> = {}) => ({
  v: PUSH_SECTION_VERSION,
  transport: 'expo',
  token: 'ExponentPushToken[abc]',
  platform: 'ios',
  types: { message: true, request: true },
  updatedAt: 100,
  ...over
})

const section = (rows: Record<string, unknown>, seen: Record<string, unknown> = {}) =>
  readPushSection({ push: { registrations: rows, seen } })

const MESSAGE: PushMessage = { body: 'sent you a message', data: { bot: 'researcher' }, title: 'Researcher' }

const registration = (installationId: string, token: string): PushRegistration => ({
  installationId,
  transport: 'expo',
  token,
  platform: 'ios',
  types: { cron: true, dm: true, message: true, request: true },
  preview: false,
  updatedAt: 0
})

describe('reading a registration', () => {
  it('takes an Expo entry that carries its token', () => {
    expect(pushRegistrationOf('dev-1', expoRow())?.token).toBe('ExponentPushToken[abc]')
  })

  it('refuses a version it does not know, rather than guessing at the shape', () => {
    // The cost is one device that stops being notified until it updates. The
    // alternative is sending a token somewhere it does not belong.
    expect(pushRegistrationOf('dev-1', expoRow({ v: 2 }))).toBeNull()
  })

  it('refuses an entry with no address', () => {
    expect(pushRegistrationOf('dev-1', expoRow({ token: '' }))).toBeNull()
    expect(pushRegistrationOf('dev-1', { ...expoRow(), transport: 'webpush', token: undefined })).toBeNull()
  })

  it('refuses an entry that carries both transports’ fields', () => {
    // Two addresses is a confusion, not a choice, and picking one of them is
    // how a notification goes to a device the owner thought they had removed.
    expect(pushRegistrationOf('dev-1', expoRow({ endpoint: 'https://push.example/x' }))).toBeNull()
  })

  it('takes a Web Push entry only with both of its keys', () => {
    const web = {
      v: PUSH_SECTION_VERSION,
      transport: 'webpush',
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'p', auth: 'a' },
      platform: 'web',
      types: { message: true },
      updatedAt: 1
    }

    expect(pushRegistrationOf('dev-2', web)?.endpoint).toBe('https://push.example/x')
    expect(pushRegistrationOf('dev-2', { ...web, keys: { p256dh: 'p' } })).toBeNull()
  })

  it('treats an absent type as OFF', () => {
    // A new event kind must not start notifying every registration written
    // before it existed.
    expect(pushRegistrationOf('dev-1', expoRow())?.types.cron).toBe(false)
    expect(pushRegistrationOf('dev-1', expoRow())?.types.message).toBe(true)
  })

  it('defaults the preview off, because a lock screen is not private', () => {
    expect(pushRegistrationOf('dev-1', expoRow())?.preview).toBe(false)
    expect(pushRegistrationOf('dev-1', expoRow({ preview: true }))?.preview).toBe(true)
  })
})

describe('reading the section', () => {
  it('keeps the readable entries and drops the rest', () => {
    const read = section({ good: expoRow(), bad: expoRow({ v: 9 }), worse: 'not an object' })

    expect(read.registrations.map(row => row.installationId)).toEqual(['good'])
  })

  it('answers empty for anything that is not a section', () => {
    expect(readPushSection(null).registrations).toEqual([])
    expect(readPushSection({ push: 'no' }).registrations).toEqual([])
    expect(readPushSection({}).seen).toEqual({})
  })

  it('narrows to the devices that asked about one kind of event', () => {
    const read = section({ a: expoRow({ types: { message: true } }), b: expoRow({ types: { cron: true } }) })

    expect(registrationsFor(read, 'message').map(row => row.installationId)).toEqual(['a'])
    expect(registrationsFor(read, 'cron').map(row => row.installationId)).toEqual(['b'])
  })

  it('reads the heartbeat that says somebody is looking', () => {
    const read = section({ a: expoRow() }, { a: 1_000, stale: 'no' })

    expect(someoneAttached(read, 1_020, 60)).toBe(true)
    expect(someoneAttached(read, 2_000, 60)).toBe(false)
    expect(read.seen.stale).toBeUndefined()
  })
})

describe('sending through Expo', () => {
  const answering = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

  it('posts one batch and keeps a ticket per device', async () => {
    const fetchImpl = answering({
      data: [
        { status: 'ok', id: 't-1' },
        { status: 'ok', id: 't-2' }
      ]
    })

    const result = await sendExpo([registration('dev-1', 'tok-1'), registration('dev-2', 'tok-2')], MESSAGE, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toBe(EXPO_SEND_URL)
    expect(result.tickets.map(ticket => ticket.id)).toEqual(['t-1', 't-2'])
    expect(result.dead).toEqual([])
  })

  it('removes a registration Expo says is gone', async () => {
    const fetchImpl = answering({
      data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]
    })

    const result = await sendExpo([registration('dev-1', 'tok-1')], MESSAGE, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.dead).toEqual(['dev-1'])
  })

  it('learns nothing about a token from a request that never landed', async () => {
    // A batch can die for the network's reasons. Treating that as a dead token
    // would unregister every device on the first flaky minute.
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })

    const result = await sendExpo([registration('dev-1', 'tok-1')], MESSAGE, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.dead).toEqual([])
    expect(result.tickets[0]?.error).toMatch(/ECONNRESET/)
  })

  it('says nothing to Web Push registrations', async () => {
    const fetchImpl = answering({ data: [] })
    const web: PushRegistration = {
      ...registration('dev-web', ''),
      transport: 'webpush',
      endpoint: 'https://push.example/x'
    }

    delete (web as { token?: string }).token

    expect(await sendExpo([web], MESSAGE, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      dead: [],
      tickets: []
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('reading the receipts', () => {
  it('is where a dead token is actually learned', async () => {
    // A ticket only says Expo accepted the request. Whether Apple took it is
    // in the receipt, and a sender that never reads one pushes to uninstalled
    // apps for ever.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { 't-1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }),
          {
            status: 200
          }
        )
    )

    const result = await readExpoReceipts([{ id: 't-1', installationId: 'dev-1', token: 'tok-1' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toBe(EXPO_RECEIPTS_URL)
    expect(result.dead).toEqual(['dev-1'])
  })

  it('treats a receipt that is not there yet as pending, never as delivered', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }))

    const result = await readExpoReceipts([{ id: 't-1', installationId: 'dev-1', token: 'tok-1' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.dead).toEqual([])
    expect(result.pending.map(ticket => ticket.id)).toEqual(['t-1'])
  })

  it('asks nothing when no ticket was accepted', async () => {
    const fetchImpl = vi.fn()

    expect(await readExpoReceipts([{ error: 'no ticket', installationId: 'dev-1', token: 'tok-1' }])).toEqual({
      dead: [],
      pending: []
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
