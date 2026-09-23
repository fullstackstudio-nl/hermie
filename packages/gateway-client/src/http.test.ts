/**
 * `GatewayHttp.authMe`'s `picture_url` field, and `fetchAuthenticatedPicture`
 * itself — HERM-120.
 *
 * The picture endpoint is authenticated the same way every other REST call is,
 * so its tests reuse the same fake-fetch scaffolding `fetch-json.test.ts`
 * built rather than inventing a second one.
 */
import { describe, expect, it } from 'vitest'

import type { CredentialProvider } from './credentials'
import type { FetchLike } from './fetch-json'
import { GatewayHttp } from './http'

const BASE = 'http://gateway.test'

function answering(body: BodyInit, init: ResponseInit = {}): FetchLike {
  return (async () => new Response(body, init)) as unknown as FetchLike
}

const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

const httpWith = (fetchImpl: FetchLike, credentials: CredentialProvider = anonymous) =>
  new GatewayHttp({ baseUrl: BASE, credentials, fetchImpl })

describe('authMe', () => {
  it('parses picture_url when the gateway sends one', async () => {
    const http = httpWith(
      answering(
        JSON.stringify({
          user_id: 'self-hosted:sam-sub',
          email: 'sam@example.test',
          display_name: 'Sam',
          org_id: '',
          provider: 'self-hosted',
          expires_at: 0,
          picture_url: '/api/auth/picture?id=self-hosted%3Asam-sub'
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )

    const identity = await http.authMe()

    expect(identity.pictureUrl).toBe('/api/auth/picture?id=self-hosted%3Asam-sub')
    expect(identity.email).toBe('sam@example.test')
  })

  it('answers an empty pictureUrl from an upstream gateway that never sends the field', async () => {
    const http = httpWith(
      answering(JSON.stringify({ user_id: 'x', email: '', display_name: '', org_id: '', provider: '', expires_at: 0 }))
    )

    const identity = await http.authMe()

    expect(identity.pictureUrl).toBe('')
  })
})

describe('fetchAuthenticatedPicture', () => {
  it('returns a data: URI for a 200 image, carrying the response content-type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const http = httpWith(
      (async () =>
        new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as FetchLike
    )

    const outcome = await http.fetchAuthenticatedPicture('/api/auth/picture?id=self-hosted%3Asam-sub')

    expect(outcome.kind).toBe('ready')
    expect(outcome.kind === 'ready' ? outcome.dataUri : '').toMatch(/^data:image\/png;base64,/)
  })

  it('answers "missing" on a 404 and never throws', async () => {
    const http = httpWith(answering('not found', { status: 404 }))

    await expect(http.fetchAuthenticatedPicture('/api/auth/picture?id=nobody')).resolves.toEqual({ kind: 'missing' })
  })

  it('answers "error" on a 401 once the credential provider says reauth', async () => {
    const http = httpWith(answering('nope', { status: 401 }))

    await expect(http.fetchAuthenticatedPicture('/api/auth/picture?id=x')).resolves.toEqual({ kind: 'error' })
  })

  it('retries once on 401 when the credential provider says retry, and succeeds', async () => {
    let calls = 0
    const fetchImpl: FetchLike = (async () => {
      calls += 1

      return calls === 1
        ? new Response('nope', { status: 401 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }) as unknown as FetchLike

    const retrying: CredentialProvider = { ...anonymous, onRejected: async () => 'retry' as const }
    const http = httpWith(fetchImpl, retrying)

    const outcome = await http.fetchAuthenticatedPicture('/api/auth/picture?id=x')

    expect(calls).toBe(2)
    expect(outcome.kind).toBe('ready')
  })

  it('answers "error" rather than throwing when the network call rejects', async () => {
    const http = httpWith((async () => {
      throw new Error('network down')
    }) as unknown as FetchLike)

    await expect(http.fetchAuthenticatedPicture('/api/auth/picture?id=x')).resolves.toEqual({ kind: 'error' })
  })

  it('sends the credential provider auth headers on the picture request', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl: FetchLike = (async (_url: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()))

      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as FetchLike

    const bearer: CredentialProvider = { ...anonymous, httpAuthHeaders: async () => ({ authorization: 'Bearer tok' }) }
    const http = httpWith(fetchImpl, bearer)

    await http.fetchAuthenticatedPicture('/api/auth/picture?id=x')

    expect(seen[0]?.authorization).toBe('Bearer tok')
  })
})
