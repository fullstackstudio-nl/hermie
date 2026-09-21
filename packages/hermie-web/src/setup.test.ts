import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from './server'
import { normalizeGatewayInput, probeGateway, readSetup, SETUP_FILE, writeSetup } from './setup'
import { loadPushState } from './push/state'

/**
 * The operator setup window of
 * [ADR-0024](../../../docs/adr/0024-hermie-web-is-a-service-layer.md).
 *
 * Every assertion here is about the same property from a different side: a
 * Hermie Web nobody has given a gateway to has a way to acquire one, and the
 * moment it has one that way is gone — for this process and for the next.
 *
 * The gateway is started WITHOUT `publicHost` on purpose. The rebinding guard is
 * `server.test.ts`'s subject; here the server-side probe talks to the gateway
 * directly, as an operator's own machine does, and arming a guard against the
 * gateway's own address would only be testing the fake.
 */

const state = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'hermie-web-setup-'))

let gateway: FakeGateway
let staticDir: string

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-setup-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  gateway = await startFakeGateway({ port: 0, auth: 'cookie' })
})

afterAll(async () => {
  await gateway.close()
})

/** An unconfigured server: no flag, no environment, and a state directory of its own. */
async function unconfigured(stateDir: string): Promise<HermieWebServer> {
  return startHermieWeb({ port: 0, staticDir, stateDir, version: '9.9.9', selfUpdate: false, env: {} })
}

const post = (server: HermieWebServer, path: string, body: unknown) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('normalizeGatewayInput', () => {
  it('reads a bare host as plain http, because the answer is nearly always loopback', () => {
    expect(normalizeGatewayInput('127.0.0.1:9119')).toBe('http://127.0.0.1:9119')
  })

  it('keeps a path prefix and drops the trailing slash', () => {
    expect(normalizeGatewayInput('https://hermes.example/gw/')).toBe('https://hermes.example/gw')
    expect(normalizeGatewayInput('https://hermes.example/')).toBe('https://hermes.example')
  })

  it('refuses an empty address and a scheme that is not http', () => {
    expect(() => normalizeGatewayInput('   ')).toThrow(/Enter the gateway address/)
    expect(() => normalizeGatewayInput('ws://hermes.example')).toThrow(/not an http or https address/)
  })
})

describe('the saved setup', () => {
  it('round-trips, and lands 0600', async () => {
    const dir = await state()
    await writeSetup(dir, { gatewayUrl: 'http://127.0.0.1:9119', publicUrl: '', savedAt: 42 })

    expect(await readSetup(dir)).toEqual({ gatewayUrl: 'http://127.0.0.1:9119', publicUrl: '', savedAt: 42 })
    expect((await stat(path.join(dir, SETUP_FILE))).mode & 0o777).toBe(0o600)
  })

  it('reads a file from another version as no setup at all', async () => {
    const dir = await state()
    await writeFile(path.join(dir, SETUP_FILE), JSON.stringify({ v: 99, gatewayUrl: 'http://x' }), 'utf8')

    expect(await readSetup(dir)).toBeNull()
  })
})

describe('the server-side probe', () => {
  it('reads the gateway’s auth flows and providers', async () => {
    const probe = await probeGateway(gateway.url)

    expect(probe.authRequired).toBe(true)
    expect(probe.authFlows).toContain('cookie')
    expect(probe.providers.map(provider => provider.name)).toEqual(['self-hosted'])
  })

  it('says what is wrong in a sentence an operator can act on', async () => {
    // An ungated gateway, so a wrong path answers 404 rather than the 401 a
    // gated one gives everything: "that is not a Hermes gateway" is the verdict
    // worth proving, and a 401 would hide it behind an access-proxy sentence.
    const open = await startFakeGateway({ port: 0, auth: 'none' })

    try {
      await expect(probeGateway(`${open.url}/not-a-gateway`)).rejects.toThrow(/not a Hermes gateway/)
    } finally {
      await open.close()
    }
  })

  it('names the access proxy when one is in the way', async () => {
    await expect(probeGateway(`${gateway.url}/not-a-gateway`)).rejects.toThrow(/behind an access proxy/)
  })
})

describe('a Hermie Web with no gateway', () => {
  let web: HermieWebServer
  let stateDir: string

  beforeAll(async () => {
    stateDir = await state()
    web = await unconfigured(stateDir)
  })

  afterAll(async () => {
    await web.close()
  })

  it('does not call a default address a decision', () => {
    expect(web.options.gatewayConfigured).toBe(false)
  })

  it('serves the setup page, and sends the root to it', async () => {
    const page = await fetch(`${web.url}/setup`)

    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Set up Hermie Web')

    const root = await fetch(`${web.url}/`, { redirect: 'manual' })

    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/setup')
  })

  it('refuses to proxy rather than dialling an address nobody chose', async () => {
    const response = await fetch(`${web.url}/api/status`)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'setup_required' })
  })

  it('tells the app the setup is still open', async () => {
    const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as Record<string, unknown>

    expect(config.setupRequired).toBe(true)
    // Nothing is claimed about a gateway that has not been chosen: `null` is
    // "we could not read it", which is what makes the app probe for itself.
    expect(config.authKinds).toBeNull()
  })

  it('probes a candidate gateway on the operator’s behalf', async () => {
    const answer = await post(web, '/hermie/setup/probe', { gateway: gateway.url })
    const body = (await answer.json()) as { gateway: string; probe: { authFlows: string[] } }

    expect(answer.status).toBe(200)
    expect(body.gateway).toBe(gateway.url.replace(/\/+$/, ''))
    expect(body.probe.authFlows).toContain('cookie')
  })

  it('reports a probe failure as a sentence, not a stack', async () => {
    const answer = await post(web, '/hermie/setup/probe', { gateway: 'http://127.0.0.1:1' })

    expect(answer.status).toBe(400)
    expect((await answer.json()) as Record<string, unknown>).toMatchObject({ error: 'probe_failed' })
  })

  it('refuses an address that is not one, before it dials anything', async () => {
    const answer = await post(web, '/hermie/setup/save', { gateway: 'ws://nope' })

    expect(answer.status).toBe(400)
    expect((await answer.json()) as Record<string, unknown>).toMatchObject({ error: 'bad_gateway_address' })
  })
})

describe('the service login, run in the operator’s browser', () => {
  let web: HermieWebServer
  let stateDir: string

  beforeAll(async () => {
    stateDir = await state()
    web = await unconfigured(stateDir)
  })

  afterAll(async () => {
    await web.close()
  })

  it('stores the refresh token the daemon will spend, and only that', async () => {
    const started = await post(web, '/hermie/setup/login', { gateway: gateway.url, provider: 'self-hosted' })
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string }

    expect(started.status).toBe(200)
    // The redirect has to name THIS server, because this server is what listens
    // for it — the loopback port `hermie-web login` opens does not exist here.
    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(`${web.url}/hermie/setup/callback`)

    // Approve, exactly as the operator's browser would: the fake gateway is its
    // own identity provider and `auto=1` is its "yes".
    const approved = new URL(authorizeUrl)
    approved.searchParams.set('auto', '1')
    const redirect = await fetch(approved, { redirect: 'manual' })
    const landing = await fetch(redirect.headers.get('location') ?? '')

    expect(landing.status).toBe(200)
    expect(await landing.text()).toContain('service is signed in')

    const stored = await loadPushState(stateDir)

    expect(stored.oidc?.refreshToken).toBeTruthy()
    expect(stored.oidc?.gateway).toBe(gateway.url)
  })

  it('stores nothing for a redirect carrying somebody else’s state', async () => {
    const dir = await state()
    const other = await unconfigured(dir)

    try {
      await post(other, '/hermie/setup/login', { gateway: gateway.url })
      const answer = await fetch(`${other.url}/hermie/setup/callback?code=abc&state=not-ours`)

      expect(answer.status).toBe(400)
      expect(await answer.text()).toContain('Sign-in failed')
      expect((await loadPushState(dir)).oidc).toBeUndefined()
    } finally {
      await other.close()
    }
  })
})

describe('saving the gateway', () => {
  let web: HermieWebServer
  let stateDir: string

  beforeAll(async () => {
    stateDir = await state()
    web = await unconfigured(stateDir)
    const answer = await post(web, '/hermie/setup/save', { gateway: gateway.url })

    expect(answer.status).toBe(200)
  })

  afterAll(async () => {
    await web.close()
  })

  it('closes the window for good', async () => {
    expect((await fetch(`${web.url}/setup`)).status).toBe(404)
    expect((await post(web, '/hermie/setup/probe', { gateway: gateway.url })).status).toBe(404)
    expect((await post(web, '/hermie/setup/save', { gateway: gateway.url })).status).toBe(404)
  })

  it('starts proxying the gateway it was given', async () => {
    const response = await fetch(`${web.url}/api/status`)

    expect(response.status).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ auth_required: true })
  })

  it('tells the app what the gateway takes, so the wizard has nothing to probe', async () => {
    const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as Record<string, unknown>

    expect(config.setupRequired).toBe(false)
    expect(config.authRequired).toBe(true)
    expect(config.authKinds).toContain('cookie')
    expect(config.providers).toEqual([{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: true }])
    expect(config.gatewayOrigin).toBe(new URL(gateway.url).origin)
  })

  it('serves the app at the root again', async () => {
    const root = await fetch(`${web.url}/`, { redirect: 'manual' })

    expect(root.status).toBe(200)
    expect(await root.text()).toContain('Hermie')
  })

  it('makes the NEXT start a configured one', async () => {
    const written = JSON.parse(await readFile(path.join(stateDir, SETUP_FILE), 'utf8')) as { gatewayUrl: string }

    expect(written.gatewayUrl).toBe(gateway.url.replace(/\/+$/, ''))

    const restarted = await unconfigured(stateDir)

    try {
      expect(restarted.options.gatewayConfigured).toBe(true)
      expect((await fetch(`${restarted.url}/setup`)).status).toBe(404)
    } finally {
      await restarted.close()
    }
  })

  it('lets a flag beat the file, so an operator can override their own deployment', async () => {
    const overridden = await startHermieWeb({
      port: 0,
      staticDir,
      stateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: {},
      gatewayUrl: 'http://127.0.0.1:9999'
    })

    try {
      expect(overridden.options.gatewayUrl).toBe('http://127.0.0.1:9999/')
    } finally {
      await overridden.close()
    }
  })
})
