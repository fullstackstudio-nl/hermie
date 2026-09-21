/**
 * The two transports behind one door, and the sweep that reads Expo's second
 * answer.
 *
 * The receipt sweep is the part with no analogue on the Web Push side and the
 * part a sender usually gets wrong: a ticket says a request was ACCEPTED, and a
 * sender that stops reading there keeps pushing to uninstalled apps until Expo
 * rate-limits it.
 */
import { describe, expect, it, vi } from 'vitest'

import { EXPO_RECEIPTS_URL, EXPO_SEND_URL, type PushMessage } from './expo'
import type { PushRegistration } from './registrations'
import { createSender, MAX_PENDING_TICKETS, parkTickets, pollExpoReceipts, TICKET_TTL_SECONDS } from './senders'
import { PUSH_STATE_VERSION, type PushState } from './state'
import { generateSubscriptionKeys, generateVapidKeys } from './web-push'

const NOW = 1_800_000_000
const MESSAGE: PushMessage = { title: 'Researcher', body: 'sent you a message', data: { bot: 'researcher' } }
const vapid = { keys: generateVapidKeys(), subject: 'https://hermie.dev' }

const state = (over: Partial<PushState> = {}): PushState => ({
  v: PUSH_STATE_VERSION,
  seq: {},
  sent: {},
  invalid: {},
  tickets: [],
  ...over
})

const expo = (installationId: string): PushRegistration => ({
  installationId,
  transport: 'expo',
  token: `ExponentPushToken[${installationId}]`,
  platform: 'ios',
  types: { message: true, request: true, dm: true, cron: true },
  preview: false,
  updatedAt: 0
})

const web = (installationId: string): PushRegistration => ({
  installationId,
  transport: 'webpush',
  endpoint: 'https://push.test/ep',
  keys: generateSubscriptionKeys(),
  platform: 'web',
  types: { message: true, request: true, dm: true, cron: true },
  preview: false,
  updatedAt: 0
})

describe('one send over two transports', () => {
  it('reaches each registration through its own address, and parks the Expo tickets', async () => {
    const seen: string[] = []
    const current = state()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)

      if (url === EXPO_SEND_URL) {
        return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 })
      }

      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch

    await createSender({ state: current, vapid, fetchImpl, now: () => NOW }).send(
      [expo('dev-1'), web('dev-2')],
      MESSAGE
    )

    expect(seen).toEqual([EXPO_SEND_URL, 'https://push.test/ep'])
    expect(current.tickets).toEqual([
      { id: 'ticket-1', installationId: 'dev-1', token: 'ExponentPushToken[dev-1]', at: NOW }
    ])
  })

  it('answers with everything both transports condemned', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input) === EXPO_SEND_URL
        ? new Response(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }), {
            status: 200
          })
        : new Response(null, { status: 410 })
    ) as unknown as typeof fetch

    const { dead } = await createSender({ state: state(), vapid, fetchImpl, now: () => NOW }).send(
      [expo('dev-1'), web('dev-2')],
      MESSAGE
    )

    expect(dead.sort()).toEqual(['dev-1', 'dev-2'])
  })
})

describe('parking tickets', () => {
  it('keeps only what can be looked up, and only so many of them', () => {
    const current = state()
    parkTickets(current, [{ installationId: 'dev-1', token: 't' }], NOW)

    expect(current.tickets).toHaveLength(0)

    for (let at = 0; at < MAX_PENDING_TICKETS + 50; at += 1) {
      parkTickets(current, [{ id: `t${String(at)}`, installationId: 'dev-1', token: 't' }], NOW)
    }

    expect(current.tickets).toHaveLength(MAX_PENDING_TICKETS)
    // The oldest go first, which is also the order they stop being answerable in.
    expect(current.tickets[0]?.id).toBe('t50')
  })
})

describe('the receipt sweep', () => {
  const ticket = (id: string, at = NOW) => ({ id, installationId: `dev-${id}`, token: 't', at })

  it('retires a token a receipt condemns', async () => {
    const current = state({ tickets: [ticket('a')] })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(EXPO_RECEIPTS_URL)

      return new Response(
        JSON.stringify({ data: { a: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }),
        {
          status: 200
        }
      )
    }) as unknown as typeof fetch

    const result = await pollExpoReceipts(current, { state: current, vapid, fetchImpl, now: () => NOW })

    expect(result.dead).toEqual(['dev-a'])
    expect(current.invalid['dev-a']).toBe(NOW)
    expect(current.tickets).toHaveLength(0)
  })

  it('keeps a receipt that has not resolved yet, because absent is not delivered', async () => {
    const current = state({ tickets: [ticket('a')] })
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    ) as unknown as typeof fetch

    await pollExpoReceipts(current, { state: current, vapid, fetchImpl, now: () => NOW })

    expect(current.tickets).toEqual([ticket('a')])
  })

  it('keeps the original timestamp across a sweep, so a ticket still ages out', async () => {
    const current = state({ tickets: [ticket('a', NOW - 1000)] })
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    ) as unknown as typeof fetch

    await pollExpoReceipts(current, { state: current, vapid, fetchImpl, now: () => NOW })

    expect(current.tickets[0]?.at).toBe(NOW - 1000)
  })

  it('drops a ticket older than Expo will answer for, without asking', async () => {
    const current = state({ tickets: [ticket('a', NOW - TICKET_TTL_SECONDS - 1)] })
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await pollExpoReceipts(current, { state: current, vapid, fetchImpl, now: () => NOW })

    expect(result.expired).toBe(1)
    expect(current.tickets).toHaveLength(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('learns nothing from a lookup that failed, and forgets nothing either', async () => {
    const current = state({ tickets: [ticket('a')] })
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    const result = await pollExpoReceipts(current, { state: current, vapid, fetchImpl, now: () => NOW })

    expect(result.dead).toEqual([])
    expect(current.tickets).toHaveLength(1)
  })
})
