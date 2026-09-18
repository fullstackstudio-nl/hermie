import { describe, expect, it, vi } from 'vitest'

import { PROBE_TIMEOUT_MS, probeGateway } from './probe'
import { GatewayError } from './types'

type Route = { status?: number; body?: unknown; text?: string; throws?: Error }

/** A fetch stand-in that answers by pathname. */
function stubFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]

    if (!route) {
      return new Response('not found', { status: 404 })
    }

    if (route.throws) {
      throw route.throws
    }

    const body = route.text ?? JSON.stringify(route.body ?? {})

    return new Response(body, { status: route.status ?? 200 })
  }) as typeof fetch
}

const gatedStatus = {
  version: '0.21.3',
  auth_required: true,
  auth_providers: ['self-hosted'],
  auth_flows: ['cookie', 'native_pkce']
}

describe('probeGateway', () => {
  it('reads an ungated gateway without asking for providers', async () => {
    let providersAsked = false
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))

      if (url.pathname === '/api/auth/providers') {
        providersAsked = true
      }

      return new Response(JSON.stringify({ version: '0.21.3', auth_required: false, auth_flows: [] }), { status: 200 })
    }) as typeof fetch

    const result = await probeGateway('http://localhost:9119', {}, fetchImpl)

    expect(result).toEqual({
      version: '0.21.3',
      authRequired: false,
      authFlows: [],
      providers: [],
      supportsNativePkce: false
    })
    expect(providersAsked).toBe(false)
  })

  it('reads a gated gateway and its providers', async () => {
    const result = await probeGateway(
      'https://example.test',
      {},
      stubFetch({
        '/api/status': { body: gatedStatus },
        '/api/auth/providers': {
          body: { providers: [{ name: 'self-hosted', display_name: 'Self-Hosted OIDC', supports_password: false }] }
        }
      })
    )

    expect(result.authRequired).toBe(true)
    expect(result.supportsNativePkce).toBe(true)
    expect(result.version).toBe('0.21.3')
    expect(result.providers).toEqual([
      { name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }
    ])
  })

  it('treats a 503 from the provider scan as "no providers", not a failure', async () => {
    const result = await probeGateway(
      'https://example.test',
      {},
      stubFetch({ '/api/status': { body: gatedStatus }, '/api/auth/providers': { status: 503, body: {} } })
    )

    expect(result.authRequired).toBe(true)
    expect(result.providers).toEqual([])
  })

  it('sends the extra headers on every call', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)

      return new Response(JSON.stringify(String(input).includes('providers') ? { providers: [] } : gatedStatus), {
        status: 200
      })
    }) as typeof fetch

    await probeGateway('https://example.test', { 'CF-Access-Client-Id': 'abc' }, fetchImpl)

    expect(seen).toHaveLength(2)
    expect(seen.every(headers => headers['CF-Access-Client-Id'] === 'abc')).toBe(true)
  })

  it.each([
    ['a 404', { '/api/status': { status: 404, text: 'nope' } }],
    ['a non-JSON body', { '/api/status': { status: 200, text: '<html>hello</html>' } }],
    ['JSON without auth_required', { '/api/status': { status: 200, body: { version: '1' } } }]
  ])('classifies %s as not_hermes', async (_label, routes) => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch(routes as Record<string, Route>))
    ).rejects.toMatchObject({ kind: 'not_hermes' })
  })

  it('classifies a 401 on /api/status as an access-proxy problem', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { status: 401, text: '' } }))
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('classifies a 5xx as a server problem', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { status: 502, text: '' } }))
    ).rejects.toMatchObject({ kind: 'server', status: 502 })
  })

  it('classifies a certificate failure as tls', async () => {
    await expect(
      probeGateway(
        'https://example.test',
        {},
        stubFetch({ '/api/status': { throws: new Error('unable to verify the first certificate') } })
      )
    ).rejects.toMatchObject({ kind: 'tls' })
  })

  it('classifies the iOS secure-connection error code as tls', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { throws: new Error('code=-1200') } }))
    ).rejects.toMatchObject({ kind: 'tls' })
  })

  it('classifies an unreachable host as network', async () => {
    await expect(
      probeGateway(
        'https://example.test',
        {},
        stubFetch({ '/api/status': { throws: new Error('getaddrinfo ENOTFOUND') } })
      )
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('classifies a silent gateway as a timeout', async () => {
    vi.useFakeTimers()

    try {
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as typeof fetch

      const probe = probeGateway('https://example.test', {}, fetchImpl)
      const assertion = expect(probe).rejects.toMatchObject({ kind: 'timeout' })
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an address that is not http(s) before it touches the network', async () => {
    await expect(probeGateway('ws://example.test')).rejects.toBeInstanceOf(GatewayError)
  })
})
