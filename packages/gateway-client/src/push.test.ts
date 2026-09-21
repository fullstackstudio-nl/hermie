/**
 * ADR-0017's registration, as bytes.
 *
 * Three things are worth pinning here and they are all about a section that
 * belongs to more than one device:
 *
 *  - the ROW: the daemon's reader
 *    (`packages/hermie-web/src/push/registrations.ts`) drops an entry that
 *    carries the fields of both transports, so a writer that emits both is
 *    writing an entry nobody will ever send to. The expectations below are
 *    written against that reader's rules rather than against this module's own
 *    types, which is the only way the two stay in step across two packages.
 *  - the NEIGHBOURS: ADR-0016 replaces a key whole, so every case here checks
 *    what happens to rows this device did not write.
 *  - the ABSENCE: turning notifications off has to REMOVE the row, not write an
 *    empty one, because an empty one is still a registration to the reader.
 */
import { describe, expect, it } from 'vitest'

import {
  foreignPushRows,
  noPushTypes,
  PUSH_SEEN_TTL_SECONDS,
  pushRowFor,
  pushSectionFor,
  pushSeenOf,
  pushStampOf,
  pushTypesOf,
  type PushRegistrationInput
} from './push'

const NOW = 1_789_957_143

const registration = (patch: Partial<PushRegistrationInput> = {}): PushRegistrationInput => ({
  installationId: 'i-phone',
  address: { transport: 'expo', token: 'ExponentPushToken[abc]' },
  platform: 'ios',
  types: { message: true, request: true, dm: false, cron: false },
  preview: false,
  updatedAt: NOW,
  ...patch
})

/** The daemon's reader, restated: what it will and will not accept as a row. */
function readable(row: Record<string, unknown>): boolean {
  if (row.v !== 1) {
    return false
  }

  if (row.transport === 'expo') {
    return typeof row.token === 'string' && Boolean(row.token) && row.endpoint === undefined
  }

  if (row.transport === 'webpush') {
    const keys = row.keys as { p256dh?: unknown; auth?: unknown } | undefined

    return (
      typeof row.endpoint === 'string' &&
      Boolean(row.endpoint) &&
      typeof keys?.p256dh === 'string' &&
      typeof keys?.auth === 'string' &&
      row.token === undefined
    )
  }

  return false
}

describe('one row', () => {
  it('writes an expo entry with a token and no endpoint', () => {
    const row = pushRowFor(registration())

    expect(row).toEqual({
      v: 1,
      transport: 'expo',
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      types: { message: true, request: true, dm: false, cron: false },
      preview: false,
      updatedAt: NOW
    })
    expect(readable(row)).toBe(true)
  })

  it('writes a webpush entry with an endpoint and both keys, and no token', () => {
    const row = pushRowFor(
      registration({
        installationId: 'i-browser',
        platform: 'web',
        address: { transport: 'webpush', endpoint: 'https://push.example/x', keys: { p256dh: 'pp', auth: 'aa' } }
      })
    )

    expect(row.token).toBeUndefined()
    expect(row.endpoint).toBe('https://push.example/x')
    expect(row.keys).toEqual({ p256dh: 'pp', auth: 'aa' })
    expect(readable(row)).toBe(true)
  })

  it('copies the types rather than aliasing the caller’s object', () => {
    const types = { message: true, request: false, dm: false, cron: false }
    const row = pushRowFor(registration({ types })) as { types: Record<string, boolean> }

    types.message = false

    expect(row.types.message).toBe(true)
  })
})

describe('the projection', () => {
  it('carries rows this device did not write, unread', () => {
    // A row from a build that does not exist yet. It is carried because of WHO
    // wrote it, not because this build can read it: dropping it would turn a
    // version skew into another person's phone going quiet.
    const remote = { 'i-tablet': { v: 99, transport: 'martian', token: 'x' } }

    const section = pushSectionFor({ others: remote, own: registration(), seen: {}, now: NOW })

    expect(Object.keys(section?.registrations ?? {}).sort()).toEqual(['i-phone', 'i-tablet'])
    expect(section?.registrations['i-tablet']).toBe(remote['i-tablet'])
  })

  it('replaces this device’s own row rather than adding a second', () => {
    const section = pushSectionFor({
      others: {},
      own: registration({ address: { transport: 'expo', token: 'ExponentPushToken[new]' } }),
      seen: {},
      now: NOW
    })

    expect(section?.registrations['i-phone']).toMatchObject({ token: 'ExponentPushToken[new]' })
  })

  it('keeps the neighbours when this device turns notifications off', () => {
    const section = pushSectionFor({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 't' } },
      own: null,
      seen: { 'i-tablet': NOW },
      now: NOW
    })

    expect(section?.registrations).toEqual({ 'i-tablet': { v: 1, transport: 'expo', token: 't' } })
    expect(section?.registrations['i-phone']).toBeUndefined()
  })

  it('answers nothing at all when the last device leaves', () => {
    // `undefined`, not `{registrations:{},seen:{}}`: the caller omits the key,
    // so a profile belonging to somebody who never turned this on carries no
    // `push` at all.
    expect(pushSectionFor({ others: {}, own: null, seen: {}, now: NOW })).toBeUndefined()
  })

  it('treats a registration that wants no type as no registration', () => {
    const section = pushSectionFor({ others: {}, own: registration({ types: noPushTypes() }), seen: {}, now: NOW })

    expect(section).toBeUndefined()
  })

  it('sweeps a heartbeat older than its TTL and keeps a fresh one', () => {
    const section = pushSectionFor({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 't' } },
      own: null,
      seen: { 'i-gone': NOW - PUSH_SEEN_TTL_SECONDS - 1, 'i-tablet': NOW - 30 },
      now: NOW
    })

    expect(section?.seen).toEqual({ 'i-tablet': NOW - 30 })
  })

  it('keeps a stamp from the future, because that is a wrong clock and not a dead device', () => {
    const section = pushSectionFor({ others: {}, own: registration(), seen: { 'i-phone': NOW + 5_000 }, now: NOW })

    expect(section?.seen['i-phone']).toBe(NOW + 5_000)
  })
})

describe('reading a section back', () => {
  const section = {
    push: {
      registrations: {
        'i-phone': { v: 1, transport: 'expo', token: 'mine' },
        'i-tablet': { v: 1, transport: 'expo', token: 'theirs' }
      },
      seen: { 'i-phone': 10, 'i-tablet': 20, 'i-broken': 'soon', 'i-zero': 0 }
    }
  }

  it('hands back everyone else’s rows and never our own', () => {
    expect(foreignPushRows(section, 'i-phone')).toEqual({ 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } })
  })

  it('answers nothing for a bag with no push in it', () => {
    expect(foreignPushRows({ v: 1 }, 'i-phone')).toEqual({})
    expect(foreignPushRows(null, 'i-phone')).toEqual({})
    expect(pushSeenOf(undefined)).toEqual({})
  })

  it('drops a stamp that is not a positive number', () => {
    expect(pushSeenOf(section)).toEqual({ 'i-phone': 10, 'i-tablet': 20 })
  })
})

describe('the small pieces', () => {
  it('reads absent as off, exactly as the daemon does', () => {
    expect(pushTypesOf({ message: true, request: 'yes' })).toEqual({
      message: true,
      request: false,
      dm: false,
      cron: false
    })
    expect(pushTypesOf(null)).toEqual(noPushTypes())
  })

  it('stamps in seconds, because that is what the daemon compares against', () => {
    expect(pushStampOf(1_789_957_143_987)).toBe(1_789_957_143)
  })
})
