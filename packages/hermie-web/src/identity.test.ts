import { describe, expect, it } from 'vitest'

import { identityOf, IdentityReader } from './identity'

/**
 * The one round trip this service makes on somebody else's behalf.
 *
 * Two things are worth pinning: the LADDER that turns `/api/auth/me` into a
 * name (because the cache and the app must key on the same one, or a person's
 * settings and a person's transcript end up under two different names), and the
 * MEMO (because it is the only place where this service believes something
 * about a credential without asking).
 */

const ME = {
  user_id: 'ada@example.invalid',
  email: 'ada@example.invalid',
  display_name: 'Ada Lovelace',
  org_id: '',
  provider: 'self-hosted',
  expires_at: 1_790_000_000
}

describe('reading /api/auth/me', () => {
  it('takes the user id, and the address only when there is no id', () => {
    expect(identityOf(ME).userId).toBe('ada@example.invalid')
    expect(identityOf({ ...ME, user_id: '' }).userId).toBe('ada@example.invalid')
    expect(identityOf({ ...ME, user_id: '', email: '' }).userId).toBe('')
  })

  it('reads roles when the gateway sends them and invents none when it does not', () => {
    expect(identityOf(ME).roles).toEqual([])
    expect(identityOf({ ...ME, roles: ['admin', 7, 'ops'] }).roles).toEqual(['admin', 'ops'])
  })

  it('survives a body that is not one', () => {
    expect(identityOf(null)).toMatchObject({ userId: '', email: '', displayName: '', roles: [] })
    expect(identityOf('nope')).toMatchObject({ userId: '' })
  })
})

describe('the memo', () => {
  const readerWith = (over: { now?: () => number; ttlMs?: number } = {}) => {
    const asked: string[] = []
    const reader = new IdentityReader({
      ...over,
      read: async request => {
        asked.push(request.cookie ?? '')

        return request.cookie === 'good' ? identityOf(ME) : null
      }
    })

    return { asked, reader }
  }

  it('asks once per cookie inside the window', async () => {
    const { asked, reader } = readerWith()

    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })
    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })

    expect(asked).toEqual(['good'])
  })

  it('never shares an answer between two cookies', async () => {
    const { asked, reader } = readerWith()

    const first = await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })
    const second = await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'other' })

    expect(first?.userId).toBe('ada@example.invalid')
    expect(second).toBeNull()
    expect(asked).toEqual(['good', 'other'])
  })

  it('asks again once the window has passed', async () => {
    let clock = 0
    const { asked, reader } = readerWith({ now: () => clock, ttlMs: 1000 })

    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })
    clock = 1500
    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })

    expect(asked).toEqual(['good', 'good'])
  })

  it('asks again whatever the window says when the caller wants it fresh', async () => {
    const { asked, reader } = readerWith()

    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good' })
    await reader.read({ gatewayUrl: 'http://gateway.test', cookie: 'good', fresh: true })

    // Whatever this decides is destructive — the admin gate — cannot be decided
    // on a cookie that was revoked fifteen seconds ago.
    expect(asked).toEqual(['good', 'good'])
  })

  it('answers nobody for a request with no cookie, without asking at all', async () => {
    const { asked, reader } = readerWith()

    expect(await reader.read({ gatewayUrl: 'http://gateway.test', cookie: undefined })).toBeNull()
    expect(asked).toEqual([])
  })

  it('does not carry one gateway’s answer to another', async () => {
    const { asked, reader } = readerWith()

    await reader.read({ gatewayUrl: 'http://one.test', cookie: 'good' })
    await reader.read({ gatewayUrl: 'http://two.test', cookie: 'good' })

    expect(asked).toEqual(['good', 'good'])
  })
})
