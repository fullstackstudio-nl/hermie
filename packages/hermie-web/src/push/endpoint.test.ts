/**
 * `GET /push/vapid-public-key`.
 *
 * The browser build cannot subscribe without the application server's public
 * key, and it has nowhere else to get it: ADR-0017 is explicit that the app
 * never talks to the daemon, so the one thing the daemon publishes travels on
 * the origin the app is already served from.
 *
 * It is a PUBLIC key. It authorises nothing, it identifies the sender to a push
 * service, and handing it out is the entire point of having one.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type HermieWebServer, startHermieWeb } from '../server'

let gateway: FakeGateway
let web: HermieWebServer
let staticDir: string
let stateDir: string

beforeEach(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')
  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-push-state-'))
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
})

afterEach(async () => {
  await web.close()
  await gateway.close()
})

const start = (push: boolean): Promise<HermieWebServer> =>
  startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    staticDir,
    stateDir,
    version: '9.9.9',
    selfUpdate: false,
    push
  })

describe('the VAPID public key', () => {
  it('is served once the daemon has one, and is a P-256 point', async () => {
    web = await start(true)
    const response = await fetch(`${web.url}/push/vapid-public-key`)
    const body = (await response.json()) as { publicKey?: string }

    expect(response.status).toBe(200)

    const point = Buffer.from(body.publicKey ?? '', 'base64url')

    expect(point).toHaveLength(65)
    expect(point[0]).toBe(0x04)
  })

  it('is the SAME key on the next start, because a subscription is bound to it', async () => {
    web = await start(true)
    const first = (await (await fetch(`${web.url}/push/vapid-public-key`)).json()) as { publicKey?: string }
    await web.close()

    // Same state directory, new process's worth of state.
    web = await start(true)
    const second = (await (await fetch(`${web.url}/push/vapid-public-key`)).json()) as { publicKey?: string }

    expect(second.publicKey).toBe(first.publicKey)
  })

  it('leaves the availability stamp on the gateway without touching its neighbours', async () => {
    web = await start(true)

    const profile = () => gateway.state.profiles.find(row => row.is_default)
    const stamped = async (): Promise<Record<string, unknown> | undefined> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const app = profile()?.ui_meta?.['hermie-app'] as Record<string, unknown> | undefined
        const push = app?.push as Record<string, unknown> | undefined

        if (push?.vapidPublicKey) {
          return push
        }

        await new Promise(resolve => setTimeout(resolve, 10))
      }

      throw new Error('the daemon never left an availability stamp')
    }

    const push = await stamped()

    expect(push?.endpoint).toBe('/push/vapid-public-key')
    expect(push?.version).toBe('9.9.9')
    // The marker another tool owns is a sibling KEY, and ADR-0016's write is
    // per key. A daemon that wiped it would un-bot the profile it stamped.
    expect(profile()?.ui_meta?.['hermes-bots']).toEqual({})
  })

  it('says push is not running rather than inventing a key', async () => {
    web = await start(false)
    const response = await fetch(`${web.url}/push/vapid-public-key`)

    expect(response.status).toBe(503)
    expect(((await response.json()) as { error?: string }).error).toBe('push_unavailable')
  })
})
