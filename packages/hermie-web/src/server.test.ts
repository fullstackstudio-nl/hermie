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
      setupRequired: false
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
