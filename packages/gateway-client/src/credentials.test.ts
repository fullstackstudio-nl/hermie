import { describe, expect, it, vi } from 'vitest'

import {
  GATEWAY_WS_PROTOCOL,
  GATEWAY_WS_TICKET_PREFIX,
  NativePkceCredentials,
  SESSION_TOKEN_HEADER,
  SessionTokenCredentials,
  bearerFrom
} from './credentials'
import { TokenCoordinator, type TokenSet } from './native-auth'
import { isGatewayError } from './types'

const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 10_000,
  provider: 'self-hosted',
  userId: 'tester',
  ...over
})

function coordinatorWith(initial: TokenSet | null, refresh: () => Promise<TokenSet>) {
  let stored = initial

  return new TokenCoordinator({
    store: {
      async load() {
        return stored
      },
      async save(next: TokenSet) {
        stored = next
      },
      async clear() {
        stored = null
      }
    },
    refresh,
    nowSeconds: () => 0
  })
}

describe('bearerFrom', () => {
  it('reads the token back out of a header map', () => {
    expect(bearerFrom({ authorization: 'Bearer abc' })).toBe('abc')
    expect(bearerFrom({ Authorization: 'Bearer abc' })).toBe('abc')
    expect(bearerFrom({ authorization: 'Basic abc' })).toBeUndefined()
    expect(bearerFrom({})).toBeUndefined()
  })
})

describe('NativePkceCredentials', () => {
  const ticketFetch = (ticket = 'tk-1') =>
    vi.fn(async () => new Response(JSON.stringify({ ticket, ttl_seconds: 30 }), { status: 200 }))

  it('authenticates HTTP with a bearer token', async () => {
    const credentials = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(tokens(), async () => tokens())
    })

    expect(await credentials.httpAuthHeaders()).toEqual({ authorization: 'Bearer at-1' })
    expect(credentials.mode).toBe('native_pkce')
  })

  it('refuses to build headers once the user is signed out', async () => {
    const credentials = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(null, async () => tokens())
    })

    await expect(credentials.httpAuthHeaders()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('mints one ticket per dial and offers it as a subprotocol', async () => {
    const fetchImpl = ticketFetch('tk-abc')
    const credentials = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(tokens(), async () => tokens()),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const plan = await credentials.dialPlan('wss://example.test/api/ws', { 'CF-Access-Client-Id': 'x' })

    expect(plan.url).toBe('wss://example.test/api/ws')
    expect(plan.protocols).toEqual([GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}tk-abc`])
    expect(plan.headers).toEqual({ 'CF-Access-Client-Id': 'x' })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/api/auth/ws-ticket')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at-1')
    expect((init.headers as Record<string, string>)['CF-Access-Client-Id']).toBe('x')
  })

  it('reports a ticket-mint 401 as an auth failure', async () => {
    const credentials = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(tokens(), async () => tokens()),
      fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch
    })

    await expect(credentials.dialPlan('wss://example.test/api/ws', {})).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reports a ticket-mint 502 as a server failure, which the dial loop retries', async () => {
    const credentials = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(tokens(), async () => tokens()),
      fetchImpl: (async () => new Response('{}', { status: 502 })) as typeof fetch
    })

    await expect(credentials.dialPlan('wss://example.test/api/ws', {})).rejects.toMatchObject({ kind: 'server' })
  })

  /**
   * The measured case, and the reason the message changed: the gateway host was
   * answered by a reverse proxy in front of an unrelated landing page, which
   * refuses a POST to a path it does not route. "Minting a WebSocket ticket
   * failed with HTTP 405" reads as a gateway that is unwell, and the dial loop
   * treated it as one.
   */
  describe('an address that answered, but not as a gateway', () => {
    const mint = (response: () => Response) =>
      new NativePkceCredentials({
        baseUrl: 'https://hermes.example.com',
        coordinator: coordinatorWith(tokens(), async () => tokens()),
        fetchImpl: (async () => response()) as typeof fetch
      }).dialPlan('wss://hermes.example.com/api/ws', {})

    it('says what it saw, and does not guess why', async () => {
      const error = await mint(() => new Response('<!doctype html><html></html>', { status: 405 })).catch(
        (thrown: unknown) => thrown
      )

      expect(isGatewayError(error) && error.kind).toBe('protocol')
      expect(isGatewayError(error) && error.status).toBe(405)
      expect(isGatewayError(error) && error.message).toBe(
        'The address answered HTTP 405, but not as a Hermes gateway. ' +
          'This looks like a landing page, not a Hermes gateway.'
      )
      // A PUBLIC host answering with a page says nothing about a tailnet, so
      // nothing about one is said.
      expect(isGatewayError(error) && error.message).not.toMatch(/private network or tailnet/u)
    })

    it('names whoever answered, when the answer said so', async () => {
      const error = await mint(() => new Response('nope', { status: 405, headers: { server: 'nginx/1.27.0' } })).catch(
        (thrown: unknown) => thrown
      )

      expect(isGatewayError(error) && error.message).toBe(
        'The address answered HTTP 405, but not as a Hermes gateway. The answer came from nginx/1.27.0.'
      )
    })

    it('says nothing about who answered when no header named them', async () => {
      const error = await mint(() => new Response('nope', { status: 405 })).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.message).toBe('The address answered HTTP 405, but not as a Hermes gateway.')
    })

    /**
     * On the error as well as in the message: every screen writes its own
     * sentence for a KIND, and the part specific to this failure has to survive
     * that. Here the host really is one only one network can reach, so the
     * network sentence is earned.
     */
    it('carries the network sentence as a hint for a host that is on one', async () => {
      const error = await new NativePkceCredentials({
        baseUrl: 'http://gateway.ts.net',
        coordinator: coordinatorWith(tokens(), async () => tokens()),
        fetchImpl: (async () => new Response('nope', { status: 405 })) as typeof fetch
      })
        .dialPlan('ws://gateway.ts.net/api/ws', {})
        .catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.hint).toMatch(/private network or tailnet/u)
      expect(isGatewayError(error) && error.message).toMatch(/private network or tailnet/u)
    })
  })

  it('asks for a retry when a refresh succeeds and for a sign-in when it does not', async () => {
    const good = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(tokens({ expiresAt: 1 }), async () => tokens({ accessToken: 'at-2' }))
    })
    expect(await good.onRejected('at-1')).toBe('retry')

    const gone = new NativePkceCredentials({
      baseUrl: 'https://example.test',
      coordinator: coordinatorWith(null, async () => tokens())
    })
    expect(await gone.onRejected()).toBe('reauth')
  })

  it('signs out by clearing the coordinator', async () => {
    const coordinator = coordinatorWith(tokens(), async () => tokens())
    const credentials = new NativePkceCredentials({ baseUrl: 'https://example.test', coordinator })

    await credentials.signOut()

    expect(await coordinator.current()).toBeNull()
  })
})

describe('SessionTokenCredentials', () => {
  const credentials = new SessionTokenCredentials({ token: 'sekrit' })

  it('authenticates HTTP with the session-token header', async () => {
    expect(await credentials.httpAuthHeaders()).toEqual({ [SESSION_TOKEN_HEADER]: 'sekrit' })
    expect(credentials.mode).toBe('session_token')
  })

  it('puts the token in the WebSocket query string and offers no subprotocol', async () => {
    const plan = await credentials.dialPlan('ws://127.0.0.1:9119/api/ws', {})

    expect(plan.url).toBe('ws://127.0.0.1:9119/api/ws?token=sekrit')
    expect(plan.protocols).toBeUndefined()
  })

  it('always asks for a new sign-in, because a static token cannot be rotated', async () => {
    expect(await credentials.onRejected()).toBe('reauth')
  })
})
