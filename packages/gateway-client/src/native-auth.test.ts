import { describe, expect, it, vi } from 'vitest'

import {
  AuthChangedError,
  exchangeCode,
  refreshTokens,
  TokenCoordinator,
  type TokenSet,
  type TokenStore,
  tokenNeedsRefresh
} from './native-auth'

const tokenSet = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 10_000,
  provider: 'self-hosted',
  userId: 'tester',
  ...over
})

function memoryStore(initial: TokenSet | null = null): TokenStore & { value: TokenSet | null } {
  return {
    value: initial,
    async load() {
      return this.value
    },
    async save(tokens: TokenSet) {
      this.value = tokens
    },
    async clear() {
      this.value = null
    }
  }
}

const respondWith = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

describe('exchangeCode', () => {
  it('maps the bearer payload onto a TokenSet', async () => {
    const tokens = await exchangeCode(
      'https://example.test',
      { code: 'c', verifier: 'v' },
      {
        fetchImpl: respondWith(200, {
          access_token: 'at',
          refresh_token: 'rt',
          expires_at: 123,
          provider: 'self-hosted',
          user_id: 'tester'
        })
      }
    )

    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 123,
      provider: 'self-hosted',
      userId: 'tester'
    })
  })

  it('sends the code and verifier as snake_case JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }))

    await exchangeCode(
      'https://example.test',
      { code: 'the-code', verifier: 'the-verifier' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ code: 'the-code', code_verifier: 'the-verifier' })
  })

  it('turns a used or expired code (400) into an auth error', async () => {
    await expect(
      exchangeCode('https://example.test', { code: 'c', verifier: 'v' }, { fetchImpl: respondWith(400, {}) })
    ).rejects.toMatchObject({ kind: 'auth', status: 400 })
  })

  it('turns a 503 into a server error', async () => {
    await expect(
      exchangeCode('https://example.test', { code: 'c', verifier: 'v' }, { fetchImpl: respondWith(503, {}) })
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('rejects a 200 without an access token', async () => {
    await expect(
      exchangeCode('https://example.test', { code: 'c', verifier: 'v' }, { fetchImpl: respondWith(200, { ok: true }) })
    ).rejects.toMatchObject({ kind: 'protocol' })
  })
})

describe('refreshTokens', () => {
  it('rotates and returns the new set', async () => {
    const rotated = await refreshTokens(
      'https://example.test',
      { refreshToken: 'rt-1', provider: 'self-hosted' },
      { fetchImpl: respondWith(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_at: 9 }) }
    )

    expect(rotated.accessToken).toBe('at-2')
    expect(rotated.refreshToken).toBe('rt-2')
  })

  it('maps 401 session_expired onto auth', async () => {
    await expect(
      refreshTokens(
        'https://example.test',
        { refreshToken: 'rt', provider: 'p' },
        { fetchImpl: respondWith(401, { error: 'session_expired' }) }
      )
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('maps 503 onto server, because the same refresh token is still worth retrying', async () => {
    await expect(
      refreshTokens('https://example.test', { refreshToken: 'rt', provider: 'p' }, { fetchImpl: respondWith(503, {}) })
    ).rejects.toMatchObject({ kind: 'server', status: 503 })
  })

  it('refuses to call the gateway without a refresh token', async () => {
    const fetchImpl = vi.fn()

    await expect(
      refreshTokens(
        'https://example.test',
        { refreshToken: '', provider: 'p' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('tokenNeedsRefresh', () => {
  it('is true inside the 60 second window and false outside it', () => {
    expect(tokenNeedsRefresh(tokenSet({ expiresAt: 1000 }), 950)).toBe(true)
    expect(tokenNeedsRefresh(tokenSet({ expiresAt: 1000 }), 939)).toBe(false)
    expect(tokenNeedsRefresh(tokenSet({ expiresAt: 1000 }), 1200)).toBe(true)
  })

  it('never refreshes a set without an expiry', () => {
    expect(tokenNeedsRefresh(tokenSet({ expiresAt: 0 }), 1_000_000)).toBe(false)
  })
})

describe('TokenCoordinator', () => {
  it('hands back the stored token while it is comfortably valid', async () => {
    const refresh = vi.fn()
    const coordinator = new TokenCoordinator({
      store: memoryStore(tokenSet({ expiresAt: 1000 })),
      refresh: refresh as unknown as (tokens: TokenSet) => Promise<TokenSet>,
      nowSeconds: () => 0
    })

    expect(await coordinator.accessToken()).toBe('at-1')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes proactively inside the skew window', async () => {
    const refresh = vi.fn(async () => tokenSet({ accessToken: 'at-2', expiresAt: 2000 }))
    const coordinator = new TokenCoordinator({
      store: memoryStore(tokenSet({ expiresAt: 1000 })),
      refresh,
      nowSeconds: () => 960
    })

    expect(await coordinator.accessToken()).toBe('at-2')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('runs one refresh for concurrent callers', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const refresh = vi.fn(async () => {
      await gate

      return tokenSet({ accessToken: 'at-2', expiresAt: 5000 })
    })
    const coordinator = new TokenCoordinator({
      store: memoryStore(tokenSet({ expiresAt: 10 })),
      refresh,
      nowSeconds: () => 0
    })

    const first = coordinator.accessToken({ forceRefresh: true })
    const second = coordinator.accessToken({ forceRefresh: true })
    release?.()

    expect(await first).toBe('at-2')
    expect(await second).toBe('at-2')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not rotate again for a 401 about a token that was already replaced', async () => {
    const refresh = vi.fn(async () => tokenSet({ accessToken: 'at-3' }))
    const coordinator = new TokenCoordinator({
      store: memoryStore(tokenSet({ accessToken: 'at-2', expiresAt: 10_000 })),
      refresh,
      nowSeconds: () => 0
    })

    expect(await coordinator.accessToken({ forceRefresh: true, rejectedAccessToken: 'at-1' })).toBe('at-2')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('clears the tokens when the refresh is rejected as expired', async () => {
    const store = memoryStore(tokenSet({ expiresAt: 10 }))
    const coordinator = new TokenCoordinator({
      store,
      refresh: async () => {
        const { GatewayError } = await import('./types')

        throw new GatewayError('auth', 'expired', { status: 401 })
      },
      nowSeconds: () => 0
    })

    expect(await coordinator.accessToken()).toBeNull()
    expect(store.value).toBeNull()
  })

  it('propagates a transport failure instead of signing the user out', async () => {
    const store = memoryStore(tokenSet({ expiresAt: 10 }))
    const coordinator = new TokenCoordinator({
      store,
      refresh: async () => {
        const { GatewayError } = await import('./types')

        throw new GatewayError('server', 'idp down', { status: 503 })
      },
      nowSeconds: () => 0
    })

    await expect(coordinator.accessToken()).rejects.toMatchObject({ kind: 'server' })
    expect(store.value).not.toBeNull()
  })

  it('fences a rotation that a sign-out raced', async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const inFlight = new Promise<void>(resolve => {
      started = resolve
    })
    const store = memoryStore(tokenSet({ expiresAt: 10 }))
    const coordinator = new TokenCoordinator({
      store,
      refresh: async () => {
        started?.()
        await gate

        return tokenSet({ accessToken: 'at-late' })
      },
      nowSeconds: () => 0
    })

    const pending = coordinator.accessToken()
    await inFlight
    await coordinator.clear()
    release?.()

    await expect(pending).rejects.toBeInstanceOf(AuthChangedError)
    expect(store.value).toBeNull()
  })

  it('forgets a set with no refresh token rather than looping on it', async () => {
    const store = memoryStore(tokenSet({ refreshToken: '', expiresAt: 10 }))
    const coordinator = new TokenCoordinator({ store, refresh: async () => tokenSet(), nowSeconds: () => 0 })

    expect(await coordinator.accessToken()).toBeNull()
    expect(store.value).toBeNull()
  })
})
