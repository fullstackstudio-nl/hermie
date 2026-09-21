/**
 * What the daemon puts on the wire to prove who it is.
 *
 * The interesting cases are all refusals and rotations: a grant spent twice, a
 * grant deleted because a proxy answered 429, a credential tried against a
 * gateway it was never issued for. Each one of those costs a human at a terminal
 * to undo, which is the thing a daemon is supposed to make unnecessary.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  gatewayApiUrl,
  gatewayWsUrl,
  GATEWAY_WS_PROTOCOL,
  GATEWAY_WS_TICKET_PREFIX,
  NoCredentials,
  OidcCredentials,
  PushAuthError,
  resolveCredentials,
  sameGateway,
  SESSION_TOKEN_HEADER,
  SessionTokenCredentials
} from './credentials'
import { PUSH_STATE_VERSION, type PushState, type StoredRefreshToken } from './state'

const emptyState = (over: Partial<PushState> = {}): PushState => ({
  v: PUSH_STATE_VERSION,
  seq: {},
  sent: {},
  invalid: {},
  tickets: [],
  ...over
})

const stored: StoredRefreshToken = { refreshToken: 'rt-1', provider: 'keycloak', gateway: 'http://gw.test:9119' }

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('addresses', () => {
  it('keeps a path prefix, so a gateway behind a subpath still resolves', () => {
    expect(gatewayWsUrl('https://example.test/hermes/')).toBe('wss://example.test/hermes/api/ws')
    expect(gatewayApiUrl('https://example.test/hermes/', '/auth/native/token')).toBe(
      'https://example.test/hermes/auth/native/token'
    )
  })

  it('reads two spellings of one gateway as the same gateway', () => {
    expect(sameGateway('http://gw.test:9119', 'http://gw.test:9119/')).toBe(true)
    expect(sameGateway('http://gw.test:9119', 'http://other.test:9119')).toBe(false)
    expect(sameGateway('nonsense', 'http://gw.test:9119')).toBe(false)
  })
})

describe('an ungated gateway', () => {
  it('puts the token on the upgrade and in the REST header', async () => {
    const credentials = new SessionTokenCredentials('http://gw.test:9119', 'sekrit')

    expect((await credentials.dial()).url).toBe('ws://gw.test:9119/api/ws?token=sekrit')
    expect(await credentials.httpHeaders()).toEqual({ [SESSION_TOKEN_HEADER]: 'sekrit' })
  })

  it('dials bare when there is nothing to prove', async () => {
    expect((await new NoCredentials('http://gw.test:9119').dial()).url).toBe('ws://gw.test:9119/api/ws')
  })
})

describe('an OIDC-gated gateway', () => {
  const credentialsWith = (fetchImpl: typeof fetch, persist = vi.fn(async () => undefined)) =>
    new OidcCredentials({ gatewayUrl: 'http://gw.test:9119', stored, persist, fetchImpl, now: () => 1000 })

  it('spends the refresh token for an access token and that for a single-use ticket', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)

      if (url.endsWith('/auth/native/refresh')) {
        return jsonResponse(200, { access_token: 'at-1', expires_at: 9999, refresh_token: 'rt-1' })
      }

      return jsonResponse(200, { ticket: 'tkt-1' })
    }) as unknown as typeof fetch

    const plan = await credentialsWith(fetchImpl).dial()

    expect(calls).toEqual(['http://gw.test:9119/auth/native/refresh', 'http://gw.test:9119/api/auth/ws-ticket'])
    expect(plan.protocols).toEqual([GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}tkt-1`])
  })

  it('persists a rotated refresh token, because a rotation not written is a grant lost on restart', async () => {
    const persist = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/auth/native/refresh')
        ? jsonResponse(200, { access_token: 'at-1', expires_at: 9999, refresh_token: 'rt-2' })
        : jsonResponse(200, { ticket: 't' })
    ) as unknown as typeof fetch

    await credentialsWith(fetchImpl, persist).dial()

    expect(persist).toHaveBeenCalledWith({ ...stored, refreshToken: 'rt-2' })
  })

  it('refreshes once when two calls race, because upstream treats a reused grant as an attack', async () => {
    let refreshes = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/auth/native/refresh')) {
        refreshes += 1
        await new Promise(resolve => setTimeout(resolve, 5))

        return jsonResponse(200, { access_token: 'at-1', expires_at: 9999 })
      }

      return jsonResponse(200, { ticket: 't' })
    }) as unknown as typeof fetch
    const credentials = credentialsWith(fetchImpl)

    await Promise.all([credentials.httpHeaders(), credentials.httpHeaders()])

    expect(refreshes).toBe(1)
  })

  it('treats 400, 401 and 403 as the end of the grant', async () => {
    for (const status of [400, 401, 403]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, {})) as unknown as typeof fetch
      const error = await credentialsWith(fetchImpl)
        .httpHeaders()
        .catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(PushAuthError)
      expect((error as PushAuthError).fatal).toBe(true)
    }
  })

  it('does NOT treat a throttled or timed-out refresh as the end of the grant', async () => {
    // 429 is a statement about the moment. A daemon that deleted its refresh
    // token over one would need a human at a terminal to come back.
    for (const status of [408, 429, 503]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, {})) as unknown as typeof fetch
      const error = await credentialsWith(fetchImpl)
        .httpHeaders()
        .catch((thrown: unknown) => thrown)

      expect((error as PushAuthError).fatal).toBe(false)
    }
  })
})

describe('choosing a credential', () => {
  it('prefers a token given on this invocation over a sign-in left from an earlier one', () => {
    const credentials = resolveCredentials({
      gatewayUrl: 'http://gw.test:9119',
      token: 'sekrit',
      state: emptyState({ oidc: stored }),
      persist: async () => undefined
    })

    expect(credentials.mode).toBe('token')
  })

  it('uses a stored sign-in for the gateway it was made on', () => {
    expect(
      resolveCredentials({
        gatewayUrl: 'http://gw.test:9119/',
        state: emptyState({ oidc: stored }),
        persist: async () => undefined
      }).mode
    ).toBe('oidc')
  })

  it('ignores a stored sign-in made on a different gateway', () => {
    // A credential is only meaningful for the gateway it was issued by, for the
    // same reason ADR-0017 gives about a registration.
    expect(
      resolveCredentials({
        gatewayUrl: 'http://elsewhere.test:9119',
        state: emptyState({ oidc: stored }),
        persist: async () => undefined
      }).mode
    ).toBe('none')
  })
})
