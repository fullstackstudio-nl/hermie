/**
 * The headers a front door produces have to reach every request the app makes,
 * and there are three kinds of them: the REST surface, the WebSocket dial, and
 * the unauthenticated probe the wizard runs while somebody is still typing.
 *
 * The probe is the one that would be easiest to forget and the worst to get
 * wrong: it runs BEFORE any credential exists, so on a gateway behind Access it
 * is the only call that can tell the reader whether the front door is right —
 * and a probe that went out without the headers would report "an access proxy
 * answered 403" about credentials it never sent.
 */
import { describe, expect, it, vi } from 'vitest'

import { SessionTokenCredentials } from './credentials'
import { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, type FrontDoor, frontDoorHeaders } from './front-door'
import { GatewayHttp } from './http'
import { probeGateway } from './probe'

const SECRET = 'cf-secret-value-nobody-may-print'

const ACCESS: FrontDoor = {
  kind: 'cloudflare_access',
  clientId: 'abc123.access',
  clientSecret: SECRET,
  origin: 'https://gateway.example.com'
}

const BASE = 'https://gateway.example.com'
const HEADERS = frontDoorHeaders(ACCESS, BASE)

/** What the probe's two calls answer on a gateway that is happy. */
function okGateway() {
  return vi.fn(async (url: string) =>
    url.endsWith('/api/status')
      ? new Response(JSON.stringify({ auth_required: false, auth_flows: [], version: '1.2.3' }), { status: 200 })
      : new Response(JSON.stringify({ providers: [] }), { status: 200 })
  )
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit).headers ?? {}) as Record<string, string>
}

describe('a REST call', () => {
  it('carries the front door beside the credential', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const http = new GatewayHttp({
      baseUrl: BASE,
      credentials: new SessionTokenCredentials({ token: 'st-1' }),
      extraHeaders: HEADERS,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    await http.get('/api/status')

    const sent = headersOf(fetchImpl.mock.calls[0] as unknown[])

    expect(sent[CF_ACCESS_CLIENT_ID]).toBe('abc123.access')
    expect(sent[CF_ACCESS_CLIENT_SECRET]).toBe(SECRET)
  })

  it('hands them to the loader that fetches images the client does not fetch itself', async () => {
    const http = new GatewayHttp({
      baseUrl: BASE,
      credentials: new SessionTokenCredentials({ token: 'st-1' }),
      extraHeaders: HEADERS
    })

    expect(await http.requestHeaders()).toMatchObject(HEADERS)
  })
})

describe('the WebSocket dial', () => {
  it('puts them on the upgrade, where React Native can set headers', async () => {
    const credentials = new SessionTokenCredentials({ token: 'st-1' })
    const plan = await credentials.dialPlan('wss://gateway.example.com/api/ws', HEADERS)

    expect(plan.headers).toMatchObject(HEADERS)
  })

  it('puts them on the ticket mint the dial makes first', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ticket: 'tk-1', ttl_seconds: 30 }), { status: 200 })
    )
    const { NativePkceCredentials } = await import('./credentials')
    const { TokenCoordinator } = await import('./native-auth')

    const credentials = new NativePkceCredentials({
      baseUrl: BASE,
      coordinator: new TokenCoordinator({
        store: {
          async load() {
            return { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 10_000, provider: 'p', userId: 'u' }
          },
          async save() {},
          async clear() {}
        },
        refresh: async () => {
          throw new Error('not reached')
        },
        nowSeconds: () => 0
      }),
      extraHeaders: HEADERS,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const plan = await credentials.dialPlan('wss://gateway.example.com/api/ws', HEADERS)

    expect(plan.headers).toMatchObject(HEADERS)

    const minted = headersOf(fetchImpl.mock.calls[0] as unknown[])

    expect(minted[CF_ACCESS_CLIENT_ID]).toBe('abc123.access')
    expect(minted[CF_ACCESS_CLIENT_SECRET]).toBe(SECRET)
  })
})

describe('the probe', () => {
  it('carries the front door on /api/status, which runs before any credential exists', async () => {
    const fetchImpl = okGateway()

    await probeGateway(BASE, HEADERS, fetchImpl as unknown as typeof fetch)

    const sent = headersOf(fetchImpl.mock.calls[0] as unknown[])

    expect(sent[CF_ACCESS_CLIENT_ID]).toBe('abc123.access')
    expect(sent[CF_ACCESS_CLIENT_SECRET]).toBe(SECRET)
  })

  it('carries it onto the provider scan as well, which is a second request to the same edge', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/status')
        ? new Response(JSON.stringify({ auth_required: true, auth_flows: ['native_pkce'], version: '1.2.3' }), {
            status: 200
          })
        : new Response(JSON.stringify({ providers: [{ name: 'oidc', display_name: 'OIDC' }] }), { status: 200 })
    )

    await probeGateway(BASE, HEADERS, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl.mock.calls).toHaveLength(2)
    expect(headersOf(fetchImpl.mock.calls[1] as unknown[])[CF_ACCESS_CLIENT_SECRET]).toBe(SECRET)
  })

  it('sends nothing extra when no front door is configured', async () => {
    const fetchImpl = okGateway()

    await probeGateway(BASE, {}, fetchImpl as unknown as typeof fetch)

    expect(Object.keys(headersOf(fetchImpl.mock.calls[0] as unknown[]))).toEqual(['accept'])
  })
})

describe('a cleartext gateway', () => {
  it('reaches the transport with nothing to send, because the headers were never built', async () => {
    const fetchImpl = okGateway()
    const withheld = frontDoorHeaders(ACCESS, 'http://gateway.example.com')

    await probeGateway('http://gateway.example.com', withheld, fetchImpl as unknown as typeof fetch)

    const sent = JSON.stringify(headersOf(fetchImpl.mock.calls[0] as unknown[]))

    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain('abc123.access')
  })
})
