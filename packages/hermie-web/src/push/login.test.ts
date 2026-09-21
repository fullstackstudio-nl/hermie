/**
 * `hermie-web login`, the one interactive moment a daemon is allowed.
 *
 * The loopback listener runs for real here — it is the part the app does NOT
 * have (it intercepts the redirect inside its WebView and never opens a port),
 * so it is the part with no existing coverage anywhere else.
 */
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAuthorizeUrl, createPkce, exchangeCode, listenForRedirect, login, REDIRECT_PATH } from './login'
import { loadPushState, PUSH_STATE_FILE, PUSH_STATE_VERSION, savePushState } from './state'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-login-'))
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('PKCE', () => {
  it('produces a verifier, its S256 challenge and a separate state value', () => {
    const pkce = createPkce()

    expect(pkce.verifier).toHaveLength(43)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkce.state).not.toBe(pkce.verifier)
  })

  it('builds the gateway’s own authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl('http://gw.test:9119', {
        challenge: 'ch',
        state: 'st',
        redirectUri: 'http://127.0.0.1:38007/callback',
        provider: 'keycloak'
      })
    )

    expect(url.pathname).toBe('/auth/native/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:38007/callback')
    expect(url.searchParams.get('provider')).toBe('keycloak')
  })
})

describe('the loopback listener', () => {
  it('takes the code off the redirect and closes the port', async () => {
    const listener = await listenForRedirect(0)

    try {
      const response = await fetch(`${listener.redirectUri}?code=abc&state=xyz`)

      expect(response.status).toBe(200)
      await expect(listener.code).resolves.toEqual({ code: 'abc', state: 'xyz' })
    } finally {
      await listener.close()
    }
  })

  it('ignores a path that is not the redirect', async () => {
    const listener = await listenForRedirect(0)

    try {
      const base = new URL(listener.redirectUri)
      // A browser fetching /favicon.ico must not look like a failed sign-in.
      const response = await fetch(`${base.origin}/favicon.ico`)

      expect(response.status).toBe(404)
    } finally {
      await listener.close()
    }
  })

  it('listens on loopback only, because RFC 8252 §8.3 is what the gateway enforces', async () => {
    const listener = await listenForRedirect(0)

    try {
      expect(listener.redirectUri.startsWith('http://127.0.0.1:')).toBe(true)
      expect(listener.redirectUri.endsWith(REDIRECT_PATH)).toBe(true)
    } finally {
      await listener.close()
    }
  })
})

describe('the exchange', () => {
  it('refuses a gateway that issues no refresh token, and names the scope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'at' })) as unknown as typeof fetch

    await expect(exchangeCode('http://gw.test:9119', { code: 'c', verifier: 'v' }, fetchImpl)).rejects.toThrow(
      /offline_access/
    )
  })

  it('says a spent code is final rather than inviting a retry of the exchange', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {})) as unknown as typeof fetch

    await expect(exchangeCode('http://gw.test:9119', { code: 'c', verifier: 'v' }, fetchImpl)).rejects.toThrow(
      /already used or has expired/
    )
  })
})

describe('the whole command', () => {
  const runLogin = async (over: { gatewayUrl?: string } = {}) => {
    const lines: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/auth/native/token')
        ? jsonResponse(200, { access_token: 'at', refresh_token: 'rt-1', provider: 'keycloak', expires_at: 10 })
        : jsonResponse(404, {})
    ) as unknown as typeof fetch

    const pending = login({
      gatewayUrl: over.gatewayUrl ?? 'http://gw.test:9119',
      stateDir,
      port: 0,
      fetchImpl,
      print: line => lines.push(line)
    })

    // The URL is printed, never opened: this may be a machine with no desktop.
    const authorizeLine = await waitForLine(lines, /auth\/native\/authorize/)
    const authorize = new URL(authorizeLine.trim())
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '')
    redirect.searchParams.set('code', 'the-code')
    redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '')

    return { pending, lines, redirect }
  }

  const waitForLine = async (lines: string[], pattern: RegExp): Promise<string> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = lines.find(line => pattern.test(line))

      if (found) {
        return found
      }

      await new Promise(resolve => setTimeout(resolve, 5))
    }

    throw new Error(`no printed line matched ${String(pattern)}`)
  }

  it('stores the refresh token, and only that, at 0600', async () => {
    const { pending, redirect } = await runLogin()
    await fetch(redirect.toString())
    const stored = await pending

    expect(stored.refreshToken).toBe('rt-1')
    expect((await stat(path.join(stateDir, PUSH_STATE_FILE))).mode & 0o777).toBe(0o600)

    const state = await loadPushState(stateDir)

    expect(state.oidc).toEqual({ refreshToken: 'rt-1', provider: 'keycloak', gateway: 'http://gw.test:9119' })
    // An access token is an hour long. A daemon holding one stops notifying in
    // the middle of the night with nothing to say why.
    expect(JSON.stringify(state)).not.toContain('"at"')
  })

  it('refuses a redirect whose state value is somebody else’s', async () => {
    const { pending, redirect } = await runLogin()
    redirect.searchParams.set('state', 'not-the-one-we-sent')
    // The assertion is attached BEFORE the redirect lands, so the rejection it
    // is about to cause never passes through the runtime unhandled.
    const refusal = expect(pending).rejects.toThrow(/wrong state value/)
    await fetch(redirect.toString())
    await refusal
    await expect(loadPushState(stateDir).then(state => state.oidc)).resolves.toBeUndefined()
  })

  it('clears the watch state when the sign-in is for a different gateway', async () => {
    // Watermarks and dedupe keys name sessions that do not exist on the new one.
    await savePushState(stateDir, {
      v: PUSH_STATE_VERSION,
      seq: { 'old-session': 12 },
      sent: { 'old-session:3': 1 },
      invalid: {},
      tickets: [],
      oidc: { refreshToken: 'rt-0', provider: 'keycloak', gateway: 'http://elsewhere.test:9119' }
    })

    const { pending, redirect } = await runLogin({ gatewayUrl: 'http://gw.test:9119' })
    await fetch(redirect.toString())
    await pending

    const state = await loadPushState(stateDir)

    expect(state.seq).toEqual({})
    expect(state.sent).toEqual({})
  })
})
