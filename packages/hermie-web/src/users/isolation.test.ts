/**
 * Two people, one Hermie Web, one gateway — and nothing of either in the
 * other's tab.
 *
 * ADR-0025 part 1 made this service hold state on behalf of readers it does not
 * have a user database for: a message cache on disk, and a proxy that carries
 * everybody's `ui_meta` writes. Part 2 adds a chat that belongs to ONE person
 * (ADR-0007, amended). Those two facts together are the reason this file
 * exists: the moment a private conversation can be read through a proxied
 * transcript route, "the cache is per gateway" stops being a documented trade
 * and starts being a leak.
 *
 * Everything below drives the real server over real sockets against the real
 * fake gateway, with two cookie sessions belonging to two accounts — which is
 * why the fake's `/api/auth/me` had to learn to answer the CALLER rather than a
 * fixed tester. A test that signed both readers in as one person would prove
 * nothing at all.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startHermieWeb, type HermieWebServer } from '../server'

const ADA = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
const GRACE = { username: 'grace', password: 'hopper1', userId: 'grace@example.invalid', displayName: 'Grace Hopper' }

let gateway: FakeGateway
let web: HermieWebServer

/** One reader's browser, reduced to the one thing a browser is: a cookie. */
interface Reader {
  cookie: string
  userId: string
}

async function signIn(account: { username: string; password: string }): Promise<Reader> {
  const login = await fetch(`${web.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'self-hosted', ...account, next: '/' })
  })

  expect(login.status).toBe(200)

  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string
  const me = await fetch(`${web.url}/api/auth/me`, { headers: { cookie } })
  const identity = (await me.json()) as { user_id: string }

  return { cookie, userId: identity.user_id }
}

/** A socket to the gateway THROUGH the proxy, minted with this reader's cookie. */
async function dial(reader: Reader): Promise<WebSocket> {
  const minted = await fetch(`${web.url}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { cookie: reader.cookie, 'content-type': 'application/json' },
    body: '{}'
  })
  const { ticket } = (await minted.json()) as { ticket: string }
  const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}/api/ws`, [
    'hermes-gateway-v1',
    `hermes-gateway-ticket.${ticket}`
  ])

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no gateway.ready within 5s')), 5000)
    socket.on('error', reject)
    socket.on('message', data => {
      if ((JSON.parse(String(data)) as { params?: { type?: string } }).params?.type === 'gateway.ready') {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  return socket
}

let nextId = 1

function call<T>(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
  const id = nextId++

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 5s`)), 5000)

    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message?: string } }

      if (frame.id !== id) {
        return
      }

      clearTimeout(timer)

      if (frame.error) {
        reject(new Error(frame.error.message ?? 'rpc error'))

        return
      }

      resolve(frame.result as T)
    })
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

interface ProfileRow {
  name: string
  is_default?: boolean
  ui_meta?: Record<string, unknown>
  ui_meta_revisions?: Record<string, number>
}

async function defaultProfile(socket: WebSocket): Promise<ProfileRow> {
  const listed = await call<{ profiles: ProfileRow[] }>(socket, 'profiles.list', {})
  const row = listed.profiles.find(profile => profile.is_default === true)

  expect(row).toBeTruthy()

  return row as ProfileRow
}

beforeAll(async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-users-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  gateway = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [ADA, GRACE], streamDelayMs: 1 })
  web = await startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    staticDir,
    stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-users-state-')),
    version: '9.9.9',
    selfUpdate: false,
    env: {}
  })
})

afterAll(async () => {
  await web.close()
  await gateway.close()
})

describe('two readers, one service', () => {
  it('answers each of them with their own identity through the proxy', async () => {
    const ada = await signIn(ADA)
    const grace = await signIn(GRACE)

    expect(ada.userId).toBe(ADA.userId)
    expect(grace.userId).toBe(GRACE.userId)
    expect(ada.cookie).not.toBe(grace.cookie)
  })

  it('keeps their app-wide settings in separate ui_meta keys', async () => {
    const ada = await signIn(ADA)
    const grace = await signIn(GRACE)
    const adaSocket = await dial(ada)
    const graceSocket = await dial(grace)

    try {
      const profile = (await defaultProfile(adaSocket)).name

      /*
        The app writes under `hermie-app:<user_id>` (ADR-0016, amended) and this
        is the web build's half of that claim: the id comes out of the cookie
        session's own `/api/auth/me`, so two browsers on ONE Hermie Web name two
        different keys without the service having to know anything about either.
      */
      await call(adaSocket, 'profiles.configure', {
        name: profile,
        ui_meta: { [`hermie-app:${ada.userId}`]: { v: 1, themeChoice: 'midnight', pinned: ['researcher'] } }
      })
      await call(graceSocket, 'profiles.configure', {
        name: profile,
        ui_meta: { [`hermie-app:${grace.userId}`]: { v: 1, themeChoice: 'daylight', pinned: ['writer'] } }
      })

      const bag = (await defaultProfile(graceSocket)).ui_meta ?? {}

      expect(bag[`hermie-app:${ada.userId}`]).toMatchObject({ themeChoice: 'midnight', pinned: ['researcher'] })
      expect(bag[`hermie-app:${grace.userId}`]).toMatchObject({ themeChoice: 'daylight', pinned: ['writer'] })
      // Neither write touched the other's key, which is the per-key
      // compare-and-swap ADR-0016 rests on doing its job through the proxy.
      expect(
        Object.keys(bag)
          .filter(key => key.startsWith('hermie-app:'))
          .sort()
      ).toEqual([`hermie-app:${ada.userId}`, `hermie-app:${grace.userId}`])
    } finally {
      adaSocket.close()
      graceSocket.close()
    }
  })

  it('moves one reader’s revision and leaves the other’s where it was', async () => {
    const ada = await signIn(ADA)
    const grace = await signIn(GRACE)
    const adaSocket = await dial(ada)
    const graceSocket = await dial(grace)

    try {
      const profile = (await defaultProfile(adaSocket)).name
      const before = (await defaultProfile(adaSocket)).ui_meta_revisions ?? {}

      await call(adaSocket, 'profiles.configure', {
        name: profile,
        ui_meta: { [`hermie-app:${ada.userId}`]: { v: 1, textSize: 'large' } },
        ui_meta_expected_revisions: { [`hermie-app:${ada.userId}`]: before[`hermie-app:${ada.userId}`] ?? 0 }
      })

      const after = (await defaultProfile(graceSocket)).ui_meta_revisions ?? {}

      expect(after[`hermie-app:${ada.userId}`]).toBe((before[`hermie-app:${ada.userId}`] ?? 0) + 1)
      expect(after[`hermie-app:${grace.userId}`]).toBe(before[`hermie-app:${grace.userId}`])
    } finally {
      adaSocket.close()
      graceSocket.close()
    }
  })

  it('still shares the per-BOT section, which is about the bot and not the reader', async () => {
    const ada = await signIn(ADA)
    const grace = await signIn(GRACE)
    const adaSocket = await dial(ada)
    const graceSocket = await dial(grace)

    try {
      await call(adaSocket, 'profiles.configure', {
        name: 'researcher',
        ui_meta: { hermie: { v: 1, colour: 'teal' } }
      })

      const listed = await call<{ profiles: ProfileRow[] }>(graceSocket, 'profiles.list', {})
      const researcher = listed.profiles.find(profile => profile.name === 'researcher')

      // ADR-0016 puts `archived` and `colour` on the BOT's profile on purpose:
      // they describe the bot. This asserts the boundary is where that record
      // says it is rather than wherever the last change left it.
      expect(researcher?.ui_meta?.hermie).toMatchObject({ colour: 'teal' })
      expect(researcher?.ui_meta?.['hermes-bots']).toBeTruthy()
    } finally {
      adaSocket.close()
      graceSocket.close()
    }
  })
})

describe('the message cache knows whose transcript it is holding', () => {
  /** One session on `researcher` that belongs to Ada and to nobody else. */
  async function adasOwnChat(socket: WebSocket): Promise<string> {
    const created = await call<{ session_id: string; stored_session_id: string }>(socket, 'session.create', {
      profile: 'researcher',
      title: `Chat · ${ADA.displayName}`,
      hidden: false
    })

    await call(socket, 'prompt.submit', { session_id: created.session_id, text: 'Something only I should read.' })
    // The reply streams; one row is enough for the cache to have something to
    // hold, and the user's own turn is persisted the moment it is submitted.
    await new Promise(resolve => setTimeout(resolve, 50))

    return created.stored_session_id
  }

  it('serves a private chat back to its owner and to nobody else', async () => {
    const ada = await signIn(ADA)
    const grace = await signIn(GRACE)
    const adaSocket = await dial(ada)

    let stored: string

    try {
      stored = await adasOwnChat(adaSocket)
    } finally {
      adaSocket.close()
    }

    // Ada reads her transcript the way the app does — the proxied REST tail —
    // and the tee on the way past is what fills the cache.
    const read = await fetch(`${web.url}/api/sessions/${stored}/messages?limit=50&order=desc`, {
      headers: { cookie: ada.cookie }
    })

    expect(read.status).toBe(200)

    const mine = await waitForCache(stored, ada.cookie)

    expect(mine.status).toBe(200)
    expect(((await mine.json()) as { rows: unknown[] }).rows.length).toBeGreaterThan(0)

    const theirs = await fetch(`${web.url}/hermie/cache/${encodeURIComponent(stored)}`, {
      headers: { cookie: grace.cookie } as Record<string, string>
    })

    // A MISS rather than a 403: the seam's contract is "paint if there is
    // something", and a refusal would also confirm the chat exists.
    expect(theirs.status).toBe(404)
    expect((await theirs.json()) as { error: string }).toMatchObject({ error: 'not_cached' })
  })

  it('does not let a private chat answer to the bot’s own name', async () => {
    const ada = await signIn(ADA)
    const adaSocket = await dial(ada)

    let stored: string

    try {
      stored = await adasOwnChat(adaSocket)
    } finally {
      adaSocket.close()
    }

    await fetch(`${web.url}/api/sessions/${stored}/messages?limit=50&order=desc`, { headers: { cookie: ada.cookie } })
    await waitForCache(stored, ada.cookie)

    // `/hermie/cache/<bot>` means "this bot's SHARED chat" — it is what the
    // seam asks for when all it holds is a profile name. A private transcript
    // answering to it would be one reader's conversation under a key every
    // other reader also asks.
    const byBot = await fetch(`${web.url}/hermie/cache/researcher`, { headers: { cookie: ada.cookie } })

    if (byBot.status === 200) {
      expect(((await byBot.json()) as { sessionId: string }).sessionId).not.toBe(stored)
    } else {
      expect(byBot.status).toBe(404)
    }
  })

  it('still refuses everybody who is not signed in at all', async () => {
    const response = await fetch(`${web.url}/hermie/cache/researcher`)

    expect(response.status).toBe(401)
  })
})

/** The tee writes after the response has gone out, so the read is retried. */
async function waitForCache(key: string, cookie: string): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${web.url}/hermie/cache/${encodeURIComponent(key)}`, {
      headers: { cookie } as Record<string, string>
    })

    if (response.status === 200) {
      return response
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  return fetch(`${web.url}/hermie/cache/${encodeURIComponent(key)}`, { headers: { cookie } as Record<string, string> })
}
