import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startHermieWeb, type HermieWebServer } from './server'
import { startPushDaemon, type PushDaemon } from './push/daemon'
import { type CacheEntry, TranscriptCache } from './cache'

/**
 * The message cache where it actually lives: on the wire
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * Three claims, one per feed and one per gate. A transcript read that goes
 * through the proxy fills the cache on its way past; the service link fills it
 * for chats nobody has opened yet; and neither of those is readable by anybody
 * who has not signed in to the gateway.
 */

const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> => {
  const until = Date.now() + timeoutMs

  while (Date.now() < until) {
    if (await predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`timed out waiting for ${label}`)
}

async function staticBuild(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-static-'))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  return dir
}

describe('the cache route, on an ungated gateway', () => {
  let gateway: FakeGateway
  let web: HermieWebServer
  let sessionId: string

  beforeAll(async () => {
    gateway = await startFakeGateway({ port: 0, auth: 'none', streamDelayMs: 1 })
    web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir: await staticBuild(),
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-state-')),
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })

    // The STORED id, which is what the REST transcript route is addressed by —
    // the same id the app's `fetchMessages` puts in that path.
    sessionId = [...gateway.state.sessions.values()].find(session => session.messages.length > 0)?.storedId ?? ''

    expect(sessionId).toBeTruthy()
  })

  afterAll(async () => {
    await web.close()
    await gateway.close()
  })

  it('fills itself from a transcript read that was going past anyway', async () => {
    const read = await fetch(`${web.url}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=50&order=latest`)
    const served = (await read.json()) as { messages?: unknown[] }

    expect(read.status).toBe(200)
    expect(served.messages?.length).toBeGreaterThan(0)

    // The copy is written after the body ends, so the browser is never waiting
    // on it — which is also why this has to wait rather than assert at once.
    await waitFor(async () => (await web.cache.get(sessionId)) !== null, 'the proxied read to be cached')

    const cached = await web.cache.get(sessionId)

    expect(cached?.shape).toBe('rest')
    expect(cached?.rows.length).toBe(served.messages?.length)
  })

  it('serves what it cached, by the session id — no credential, because there is none to have', async () => {
    const answer = await fetch(`${web.url}/hermie/cache/${encodeURIComponent(sessionId)}`)
    const body = (await answer.json()) as { rows: unknown[]; shape: string }

    expect(answer.status).toBe(200)
    expect(body.shape).toBe('rest')
    expect(body.rows.length).toBeGreaterThan(0)
  })

  it('says so plainly for a chat it has never seen', async () => {
    const answer = await fetch(`${web.url}/hermie/cache/never-heard-of-it`)

    expect(answer.status).toBe(404)
    expect((await answer.json()) as Record<string, unknown>).toMatchObject({ error: 'not_cached' })
  })

  it('leaves the proxied answer exactly as it arrived', async () => {
    // The observer is a copy, not a filter: what the browser reads must be
    // byte-for-byte what the gateway sent, however the capture went.
    const direct = await (await fetch(`${gateway.url}/api/sessions/${encodeURIComponent(sessionId)}/messages`)).text()
    const proxied = await (await fetch(`${web.url}/api/sessions/${encodeURIComponent(sessionId)}/messages`)).text()

    expect(proxied).toBe(direct)
  })
})

describe('the cache route, on a gated gateway', () => {
  let gateway: FakeGateway
  let web: HermieWebServer

  beforeAll(async () => {
    gateway = await startFakeGateway({ port: 0, auth: 'cookie', streamDelayMs: 1 })
    web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir: await staticBuild(),
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-gated-')),
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })
  })

  afterAll(async () => {
    await web.close()
    await gateway.close()
  })

  it('refuses a reader with no gateway session', async () => {
    await web.cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      storedId: '',
      shape: 'rest',
      rows: [{ role: 'assistant', row_id: 1, text: 'secret' }],
      updatedAt: 1
    })

    const answer = await fetch(`${web.url}/hermie/cache/researcher`)

    // Gateway-wide is not world-readable: the cache holds transcript content,
    // and the same check `POST /hermie/update` makes is the one that keeps
    // "shared among everyone signed in" apart from "readable off the port".
    expect(answer.status).toBe(401)
  })
})

describe('the cache with no disk budget', () => {
  it('answers 404 rather than pretending', async () => {
    const gateway = await startFakeGateway({ port: 0, auth: 'none', streamDelayMs: 1 })
    const web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir: await staticBuild(),
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-off-')),
      version: '9.9.9',
      selfUpdate: false,
      cacheMaxMb: 0,
      env: {}
    })

    try {
      expect(web.cache.enabled).toBe(false)
      expect((await fetch(`${web.url}/hermie/cache/anything`)).status).toBe(404)

      const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as {
        service: { cache: boolean }
      }

      expect(config.service.cache).toBe(false)
    } finally {
      await web.close()
      await gateway.close()
    }
  })
})

describe('the service link filling the cache', () => {
  let gateway: FakeGateway
  let daemon: PushDaemon
  let written: CacheEntry[]

  beforeAll(async () => {
    written = []
    gateway = await startFakeGateway({ port: 0, auth: 'none', streamDelayMs: 1 })
    daemon = await startPushDaemon({
      gatewayUrl: gateway.url,
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-daemon-')),
      version: '9.9.9',
      log: () => undefined,
      pollReceipts: false,
      sleep: () => Promise.resolve(),
      random: () => 0,
      cacheDebounceMs: 0,
      // A recorder rather than the store: what is under test here is that the
      // daemon FEEDS it, and `cache.test.ts` already owns what the store does.
      cache: {
        enabled: true,
        put: async entry => {
          written.push(entry)
        }
      },
      socketFactory: (url, protocols) =>
        (protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url)) as unknown as globalThis.WebSocket,
      tuning: { openingGraceMs: 0, registrationTtlMs: 0 }
    })
  })

  afterAll(async () => {
    await daemon.stop()
    await gateway.close()
  })

  it('caches every canonical Bot Chat on connect, without anybody opening one', async () => {
    await waitFor(() => written.length >= 2, 'both Bot Chats to be cached')

    const bots = new Set(written.map(entry => entry.bot))

    expect(bots.size).toBeGreaterThan(1)
    // The bot's NAME travels with the rows, because the browser's seam reads by
    // it — the proxy tee, which sees only a path, cannot supply it.
    expect(written.every(entry => entry.bot && entry.sessionId)).toBe(true)
    expect(written.every(entry => entry.rows.length > 0)).toBe(true)
  })
})

describe('a cache whose directory is a wreck', () => {
  it('answers null rather than throwing into a request', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-wreck-'))
    const cache = new TranscriptCache({ dir, maxBytes: 1024 * 1024 })

    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      storedId: '',
      shape: 'rest',
      rows: [{ role: 'assistant', row_id: 1 }],
      updatedAt: 1
    })
    // Somebody cleaned the directory by hand and left the index behind.
    await writeFile(path.join(dir, 'index.json'), await Promise.resolve('{"v":1,"entries":[]}'), 'utf8')

    const reopened = new TranscriptCache({ dir, maxBytes: 1024 * 1024 })

    expect(await reopened.get('researcher')).toBeNull()
  })
})
