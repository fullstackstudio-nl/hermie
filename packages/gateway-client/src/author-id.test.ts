/**
 * HERM-83: the reader's own author id, built from `/api/auth/me` exactly the
 * way the gateway builds the per-message author stamp.
 *
 * The gateway answers `/api/auth/me` with the provider's BARE `user_id` and the
 * `provider` beside it, and stamps a row with `"<provider>:<user_id>"`. A client
 * that compared the bare id with the stamp called every one of the reader's own
 * messages somebody else's. These tests start from the response body the
 * gateway actually sends and go through the one parser (`GatewayHttp.authMe`).
 */
import { describe, expect, it } from 'vitest'

import { authorIdOf, ownAuthorOf } from './author-id'
import type { CredentialProvider } from './credentials'
import type { FetchLike } from './fetch-json'
import { GatewayHttp } from './http'

const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

async function meFrom(body: Record<string, unknown>) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as FetchLike

  return new GatewayHttp({ baseUrl: 'http://gateway.test', credentials: anonymous, fetchImpl }).authMe()
}

const ME_BODY = {
  user_id: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
  email: 'alex@example.test',
  display_name: 'Alex Moreno',
  org_id: '',
  provider: 'authentik',
  expires_at: 1_790_000_000
}

describe('authorIdOf', () => {
  it('builds `<provider>:<user_id>` from an OIDC `/api/auth/me` answer', async () => {
    expect(authorIdOf(await meFrom(ME_BODY))).toBe('authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40')
  })

  it('builds `basic:alice` for a basic-auth login, keeping it apart from an OIDC `alice`', async () => {
    const basic = authorIdOf(await meFrom({ ...ME_BODY, user_id: 'alice', provider: 'basic' }))
    const oidc = authorIdOf(await meFrom({ ...ME_BODY, user_id: 'alice', provider: 'authentik' }))

    expect(basic).toBe('basic:alice')
    expect(oidc).toBe('authentik:alice')
  })

  it('strips surrounding whitespace from both halves, as the gateway does, and nothing else', async () => {
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: '  Alice \n', provider: '\tAuthentik ' }))).toBe(
      'Authentik:Alice'
    )
  })

  it('keeps case exactly: the gateway never folds it', async () => {
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: 'Alice', provider: 'Basic' }))).toBe('Basic:Alice')
  })

  it('strips the separators Python strips and JavaScript does not, and keeps the BOM Python keeps', () => {
    // `str.strip()` strips U+001C..U+001F and U+0085; `String.prototype.trim`
    // does not. `trim` strips U+FEFF; `str.strip()` does not.
    expect(authorIdOf({ provider: '\u001cbasic\u0085', userId: '\u001falice' })).toBe('basic:alice')
    expect(authorIdOf({ provider: 'basic', userId: '\uFEFFalice' })).toBe('basic:\uFEFFalice')
  })

  it('has no id when the provider is missing, rather than falling back to the email', async () => {
    const { provider: _provider, ...withoutProvider } = ME_BODY

    expect(authorIdOf(await meFrom(withoutProvider))).toBeUndefined()
    expect(authorIdOf(await meFrom({ ...ME_BODY, provider: '   ' }))).toBeUndefined()
  })

  it('has no id when the user id is missing, rather than falling back to the email', async () => {
    const { user_id: _userId, ...withoutUser } = ME_BODY

    expect(authorIdOf(await meFrom(withoutUser))).toBeUndefined()
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: '' }))).toBeUndefined()
  })
})

describe('ownAuthorOf', () => {
  it('carries the display name the gateway stamps beside the id, stripped', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, display_name: ' Alex Moreno ' }))).toEqual({
      id: 'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
      name: 'Alex Moreno'
    })
  })

  it('omits the name rather than carrying an empty one, and never borrows the email for it', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, display_name: '' }))).toEqual({
      id: 'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40'
    })
  })

  it('is nothing at all when there is no id to carry', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, provider: '' }))).toBeUndefined()
  })
})
