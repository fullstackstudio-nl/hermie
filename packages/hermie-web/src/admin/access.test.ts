import { describe, expect, it } from 'vitest'

import { identityOf } from '../identity'
import { hashLocalSecret, isAdminIdentity, localSecretMatches, mayProxyMethod, withAdmin, withoutAdmin } from './access'
import { AdminSessions, cookieOf, tokensMatch } from './session'
import { emptyAdminState, mayReachBot, optionsFor } from './state'

const state = (over: Partial<ReturnType<typeof emptyAdminState>> = {}) => ({ ...emptyAdminState(), ...over })

describe('the administrator list', () => {
  it('lets a named id in and keeps everybody else out', () => {
    const held = state({ admins: ['ada@example.invalid'] })

    expect(isAdminIdentity(held, identityOf({ user_id: 'ada@example.invalid' }))).toBe(true)
    expect(isAdminIdentity(held, identityOf({ user_id: 'grace@example.invalid' }))).toBe(false)
    expect(isAdminIdentity(held, null)).toBe(false)
  })

  it('never lets a gateway that named NOBODY match an empty entry', () => {
    // The bug this exists to make impossible: `''` on both sides of an
    // `includes` is a match, and the page opens to whoever reaches the port.
    const held = state({ admins: [''] })

    expect(isAdminIdentity(held, identityOf({ user_id: '' }))).toBe(false)
    expect(isAdminIdentity(held, null)).toBe(false)
  })

  it('adds without duplicating and keeps the list sorted', () => {
    const once = withAdmin(state(), 'grace@example.invalid')
    const twice = withAdmin(withAdmin(once, 'ada@example.invalid'), 'ada@example.invalid')

    expect(twice.admins).toEqual(['ada@example.invalid', 'grace@example.invalid'])
  })

  it('refuses to remove the last one', () => {
    const held = state({ admins: ['ada@example.invalid'] })
    const { state: after, removed } = withoutAdmin(held, 'ada@example.invalid')

    expect(removed).toBe(false)
    expect(after.admins).toEqual(['ada@example.invalid'])
  })

  it('removes the last one when a local secret can still get back in', () => {
    const held = state({ admins: ['ada@example.invalid'], localAdmin: hashLocalSecret('a long enough phrase') })
    const { state: after, removed } = withoutAdmin(held, 'ada@example.invalid')

    expect(removed).toBe(true)
    expect(after.admins).toEqual([])
  })
})

describe('the local administrator secret', () => {
  it('matches the one it was made from and nothing else', () => {
    const held = state({ localAdmin: hashLocalSecret('a long enough phrase') })

    expect(localSecretMatches(held, 'a long enough phrase')).toBe(true)
    expect(localSecretMatches(held, 'a long enough phras')).toBe(false)
    expect(localSecretMatches(held, '')).toBe(false)
    expect(localSecretMatches(state(), 'a long enough phrase')).toBe(false)
  })

  it('stores a salt and a hash and never the secret', () => {
    const stored = hashLocalSecret('a long enough phrase')

    expect(JSON.stringify(stored)).not.toContain('a long enough phrase')
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/u)
    expect(stored.hash).toMatch(/^[0-9a-f]{128}$/u)
  })

  it('salts each one separately, so two equal secrets do not look equal', () => {
    expect(hashLocalSecret('same').hash).not.toBe(hashLocalSecret('same').hash)
  })
})

describe('what read-only refuses', () => {
  it('lets reads past and stops the rest', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(mayProxyMethod(true, method)).toBe(true)
    }

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(mayProxyMethod(true, method)).toBe(false)
      expect(mayProxyMethod(false, method)).toBe(true)
    }
  })
})

describe('the per-person options', () => {
  it('answers the defaults for somebody nobody has decided about', () => {
    expect(optionsFor(state(), 'nobody@example.invalid')).toEqual({
      allowedBots: null,
      readOnly: false,
      pushAllowed: true
    })
  })

  it('treats no list as every bot and an empty list as none', () => {
    expect(mayReachBot({ allowedBots: null, readOnly: false, pushAllowed: true }, 'researcher')).toBe(true)
    expect(mayReachBot({ allowedBots: [], readOnly: false, pushAllowed: true }, 'researcher')).toBe(false)
    expect(mayReachBot({ allowedBots: ['notes'], readOnly: false, pushAllowed: true }, 'researcher')).toBe(false)
    expect(mayReachBot({ allowedBots: ['notes'], readOnly: false, pushAllowed: true }, 'notes')).toBe(true)
  })
})

describe('the page’s own session and token', () => {
  it('compares tokens without leaking their length through a throw', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
  })

  it('reads one cookie out of a header and nothing else', () => {
    const header = 'a=1; hermie_admin_csrf=tok%2Fen; b=2'

    expect(cookieOf(header, 'hermie_admin_csrf')).toBe('tok/en')
    expect(cookieOf(header, 'missing')).toBe('')
    expect(cookieOf(undefined, 'a')).toBe('')
  })

  it('expires a sign-in rather than holding it for the life of the process', () => {
    let clock = 0
    const sessions = new AdminSessions({ now: () => clock, ttlMs: 1000 })
    const value = sessions.create()

    expect(sessions.has(value)).toBe(true)
    clock = 1500
    expect(sessions.has(value)).toBe(false)
    expect(sessions.has('')).toBe(false)
  })

  it('drops one on sign-out', () => {
    const sessions = new AdminSessions()
    const value = sessions.create()

    sessions.drop(value)

    expect(sessions.has(value)).toBe(false)
  })
})
