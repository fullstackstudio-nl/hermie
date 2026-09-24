import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startHermieWeb, type HermieWebServer } from './server'

/**
 * Everything here runs against the real fake gateway over a real socket, and
 * with the gateway's Host/Origin guard ARMED (`publicHost`). That is the point:
 * a proxy test that lets the guard sleep proves only that bytes move, and the
 * header rewrite is the one thing this server exists to do.
 */

const PUBLIC_HOST = 'hermes.example.test'

let gateway: FakeGateway
let web: HermieWebServer
let staticDir: string

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-static-'))
  await mkdir(path.join(staticDir, '_expo', 'static', 'js'), { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')
  await writeFile(path.join(staticDir, '_expo', 'static', 'js', 'index-deadbeef0123.js'), 'console.log(1)', 'utf8')

  gateway = await startFakeGateway({ port: 0, auth: 'cookie', publicHost: PUBLIC_HOST, streamDelayMs: 1 })
  web = await startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    publicUrl: `http://${PUBLIC_HOST}`,
    staticDir,
    loginReturn: '/hermie',
    version: '9.9.9',
    selfUpdate: false
  })
})

afterAll(async () => {
  await web.close()
  await gateway.close()
})

describe('static serving', () => {
  it('serves the exported index with no-store', async () => {
    const response = await fetch(`${web.url}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, must-revalidate')
    expect(await response.text()).toContain('Hermie')
  })

  it('pins a hashed bundle for a year', async () => {
    const response = await fetch(`${web.url}/_expo/static/js/index-deadbeef0123.js`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('falls back to index.html for a deep link', async () => {
    const response = await fetch(`${web.url}/settings/appearance`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Hermie')
  })

  it('refuses to climb out of the static root', async () => {
    // Percent-encoded, so `new URL` does not normalise it away before we look.
    const response = await fetch(`${web.url}/%2e%2e%2f%2e%2e%2fpackage.json`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Hermie')
  })
})

describe('local endpoints', () => {
  it('answers healthz with its version', async () => {
    expect(await (await fetch(`${web.url}/healthz`)).json()).toEqual({ ok: true, version: '9.9.9' })
  })

  it('tells the app which gateway host it proxies to, and where to come back to', async () => {
    expect(await (await fetch(`${web.url}/hermie/config.json`)).json()).toMatchObject({
      gatewayHost: PUBLIC_HOST,
      gatewayOrigin: `http://${PUBLIC_HOST}`,
      loginReturn: '/hermie',
      version: '9.9.9',
      setupRequired: false,
      // The default, unchanged from before the flag existed.
      oidc: true
    })
  })
})

describe('http proxy', () => {
  it('reaches the gateway through the Host rewrite', async () => {
    const response = await fetch(`${web.url}/api/status`)
    const body = (await response.json()) as { auth_required: boolean; auth_flows: string[] }

    expect(response.status).toBe(200)
    expect(body.auth_required).toBe(true)
    expect(body.auth_flows).toContain('cookie')
  })

  it('rewrites Origin, which the gateway checks separately', async () => {
    const response = await fetch(`${web.url}/api/status`, { headers: { origin: web.url } })

    expect(response.status).toBe(200)
  })

  it('carries a cookie the gateway set back to the browser, without Domain', async () => {
    const response = await fetch(`${web.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', username: 'tester', password: 'hunter2', next: '/' })
    })
    const cookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(200)
    expect(cookie).toContain('hermes_session_at=')
    expect(cookie.toLowerCase()).not.toContain('domain=')
    // Hermie Web was reached over plain HTTP here, so a Secure cookie would be
    // silently dropped by a browser.
    expect(cookie.toLowerCase()).not.toContain('secure')
  })

  it('does not follow the sign-in redirect on the browser’s behalf', async () => {
    const response = await fetch(`${web.url}/auth/login?provider=self-hosted&next=/`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?next=%2F')
  })

  it('relays the gateway\u2019s own refusal rather than inventing one', async () => {
    // `/api/*` belongs to the gateway, so an unknown path there is the
    // gateway's answer to give — here a 401, because nothing authenticated it.
    const response = await fetch(`${web.url}/api/nope`)

    expect(response.status).toBe(401)
  })

  it('does not proxy a path outside the gateway prefixes', async () => {
    // `/profiles` looks gateway-ish and is not on the list, so it is the SPA.
    const response = await fetch(`${web.url}/profiles`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Hermie')
  })
})

describe('cookie sign-in end to end, through the proxy', () => {
  it('logs in, confirms, mints a ticket and reaches gateway.ready', async () => {
    const login = await fetch(`${web.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', username: 'tester', password: 'hunter2', next: '/' })
    })

    expect(await login.json()).toEqual({ ok: true, next: '/' })

    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string

    const me = await fetch(`${web.url}/api/auth/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect((await me.json()).user_id).toBe('tester@example.invalid')

    const minted = await fetch(`${web.url}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}'
    })
    const { ticket } = (await minted.json()) as { ticket: string }
    expect(minted.status).toBe(200)
    expect(ticket).toMatch(/^tk-/)

    const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}/api/ws`, [
      'hermes-gateway-v1',
      `hermes-gateway-ticket.${ticket}`
    ])

    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no gateway.ready within 5s')), 5000)
      socket.on('error', reject)
      socket.on('message', data => {
        const frame = JSON.parse(String(data)) as { params?: { type?: string } }

        if (frame.params?.type === 'gateway.ready') {
          clearTimeout(timer)
          resolve(frame as Record<string, unknown>)
        }
      })
    })

    expect(ready).toBeTruthy()
    expect(socket.protocol).toBe('hermes-gateway-v1')

    const profiles = await new Promise<{ result?: { profiles?: unknown[] } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no profiles.list answer within 5s')), 5000)
      socket.on('message', data => {
        const frame = JSON.parse(String(data)) as { id?: number; result?: { profiles?: unknown[] } }

        if (frame.id === 1) {
          clearTimeout(timer)
          resolve(frame)
        }
      })
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'profiles.list', params: {} })}\n`)
    })

    expect(Array.isArray(profiles.result?.profiles)).toBe(true)
    socket.close()
  })

  it('refuses an unauthenticated ticket mint', async () => {
    const response = await fetch(`${web.url}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })

    expect(response.status).toBe(401)
  })
})

describe('--no-oidc', () => {
  let oidcOffWeb: HermieWebServer
  let oidcOffStateDir: string

  beforeAll(async () => {
    oidcOffStateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-no-oidc-state-'))
    oidcOffWeb = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      publicUrl: `http://${PUBLIC_HOST}`,
      staticDir,
      stateDir: oidcOffStateDir,
      version: '9.9.9',
      selfUpdate: false,
      oidc: false
    })
  })

  afterAll(async () => {
    await oidcOffWeb.close()
  })

  it('says so in the bootstrap', async () => {
    expect(await (await fetch(`${oidcOffWeb.url}/hermie/config.json`)).json()).toMatchObject({ oidc: false })
  })

  it('refuses the OIDC start route with a short plain-text 403', async () => {
    const response = await fetch(`${oidcOffWeb.url}/auth/login?provider=self-hosted&next=/`, { redirect: 'manual' })

    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toContain('SSO')
  })

  it('refuses the OIDC callback route the same way', async () => {
    const response = await fetch(`${oidcOffWeb.url}/auth/callback?code=whatever&state=whatever`, {
      redirect: 'manual'
    })

    expect(response.status).toBe(403)
  })

  it('still lets password sign-in through', async () => {
    const response = await fetch(`${oidcOffWeb.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', username: 'tester', password: 'hunter2', next: '/' })
    })

    expect(response.status).toBe(200)
  })

  it('still lets /api/auth/me and logout through', async () => {
    const me = await fetch(`${oidcOffWeb.url}/api/auth/me`)

    // 401 (no session) rather than 403 — the route itself is reached, the
    // gateway is the one answering.
    expect(me.status).toBe(401)

    const logout = await fetch(`${oidcOffWeb.url}/auth/logout`, { method: 'POST', redirect: 'manual' })

    expect(logout.status).not.toBe(403)
  })

  /*
    The actual bypass this whole describe block exists to close:
    `URL.prototype.pathname` never decodes a percent-escape, and the gateway's
    own ASGI server decodes one, once, before it routes — so `/auth/login`
    compared against the literal, undecoded string read as "something else"
    here while the gateway's own router still ran the login flow.
  */
  describe('an encoded attempt at the same route', () => {
    it('refuses /auth/%6cogin exactly like the plain spelling', async () => {
      const response = await fetch(`${oidcOffWeb.url}/auth/%6cogin?provider=self-hosted`, { redirect: 'manual' })

      expect(response.status).toBe(403)
    })

    it('refuses /auth/%63allback exactly like the plain spelling', async () => {
      const response = await fetch(`${oidcOffWeb.url}/auth/%63allback?code=x&state=y`, { redirect: 'manual' })

      expect(response.status).toBe(403)
    })

    it('refuses a trailing slash the same way', async () => {
      const response = await fetch(`${oidcOffWeb.url}/auth/login/?provider=self-hosted`, { redirect: 'manual' })

      expect(response.status).toBe(403)
    })

    it('refuses an encoded slash hiding inside a segment, with a 400 rather than proxying it anywhere', async () => {
      const response = await fetch(`${oidcOffWeb.url}/auth/%2Flogin`, { redirect: 'manual' })

      expect(response.status).toBe(400)
    })

    it('does not treat a double-encoded segment as a match, one way or the other', async () => {
      // One decode pass turns `%256cogin` into the literal text `%6cogin` —
      // not `login` — which is exactly what the gateway's own single decode
      // pass would also land on, so this is not a bypass; it also is not
      // refused as if it were the OIDC route, since it plainly is not one.
      const response = await fetch(`${oidcOffWeb.url}/auth/%256cogin`, { redirect: 'manual' })

      expect(response.status).not.toBe(403)
    })

    it('refuses the encoded route regardless of method', async () => {
      const head = await fetch(`${oidcOffWeb.url}/auth/%6cogin?provider=self-hosted`, {
        method: 'HEAD',
        redirect: 'manual'
      })
      const post = await fetch(`${oidcOffWeb.url}/auth/%6cogin?provider=self-hosted`, {
        method: 'POST',
        redirect: 'manual'
      })

      expect(head.status).toBe(403)
      expect(post.status).toBe(403)
    })
  })

  describe('/auth/native/authorize', () => {
    it('refuses a provider this build does not know takes a password', async () => {
      const response = await fetch(`${oidcOffWeb.url}/auth/native/authorize?provider=okta`, { redirect: 'manual' })

      expect(response.status).toBe(403)
    })

    it('lets an empty provider through when the gateway’s only provider takes a password', async () => {
      // The gateway auto-selects its ONLY session provider, and the fake's one
      // provider takes a password — so this is native sign-in with a password,
      // not an SSO round trip. `no-oidc-proxy.test.ts` covers the other side.
      const noneAtAll = await fetch(`${oidcOffWeb.url}/auth/native/authorize`, { redirect: 'manual' })
      const explicitlyEmpty = await fetch(`${oidcOffWeb.url}/auth/native/authorize?provider=`, { redirect: 'manual' })

      expect(noneAtAll.status).not.toBe(403)
      expect(explicitlyEmpty.status).not.toBe(403)
    })

    it('lets a provider this build knows takes a password through to the gateway', async () => {
      /*
        A gateway of its own, WITHOUT `publicHost`: this is the one case in
        the file that needs `gatewayProbe`'s server-side request to
        `/api/auth/providers` to actually succeed, and the shared `gateway`
        above enforces the Host guard on every request including that one —
        the same guard the WebSocket-upgrade tests need armed. The fake
        gateway does not implement `/api/auth/providers` at all, so the
        provider list is supplied through `fetchImpl` instead of asking for
        real.
      */
      const looseGateway = await startFakeGateway({ port: 0, auth: 'cookie', streamDelayMs: 1 })
      const looseStateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-no-oidc-loose-state-'))
      const looseWeb = await startHermieWeb({
        gatewayUrl: looseGateway.url,
        port: 0,
        staticDir,
        stateDir: looseStateDir,
        version: '9.9.9',
        selfUpdate: false,
        oidc: false,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith('/api/auth/providers')) {
            return new Response(
              JSON.stringify({
                providers: [{ name: 'self-hosted', display_name: 'Self-Hosted', supports_password: true }]
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          }

          return fetch(input, init)
        }) as typeof fetch
      })

      try {
        const response = await fetch(`${looseWeb.url}/auth/native/authorize?provider=self-hosted`, {
          redirect: 'manual'
        })

        // Whatever the gateway itself answers for a route the fake gateway
        // may not implement, it is not THIS service's 403 — the point is
        // that the request reached the gateway rather than being refused
        // here.
        expect(response.status).not.toBe(403)
      } finally {
        await looseWeb.close()
        await looseGateway.close()
      }
    })

    it('refuses an SSO provider regardless of method too', async () => {
      const head = await fetch(`${oidcOffWeb.url}/auth/native/authorize?provider=okta`, {
        method: 'HEAD',
        redirect: 'manual'
      })
      const post = await fetch(`${oidcOffWeb.url}/auth/native/authorize?provider=okta`, {
        method: 'POST',
        redirect: 'manual'
      })

      expect(head.status).toBe(403)
      expect(post.status).toBe(403)
    })
  })

  it('proxies the gateway’s own /login form, where native sign-in with a password provider lands', async () => {
    const response = await fetch(`${oidcOffWeb.url}/login`, { redirect: 'manual' })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<form')
  })
})
