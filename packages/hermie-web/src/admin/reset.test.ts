/**
 * "Run setup again": the confirmation, what it clears, and what it must not.
 *
 * A file of its own because it is the one action on this service that destroys
 * an operator's configuration, and it cannot share a server with the tests that
 * assume that configuration is still there. Two servers, one per deployment
 * shape, because the interesting half of the behaviour is the difference
 * between them: a gateway that came from `/setup` can be un-set, and one that
 * came from `--gateway` cannot.
 *
 * The gateway here is ungated, which is what makes the local administrator
 * secret the way in — and the local secret is exactly what the reset throws
 * away, so it is also the proof that it did.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { hashLocalSecret } from './access'
import { ADMIN_SESSION_COOKIE } from './session'
import { emptyAdminState, loadAdminState, saveAdminState } from './state'
import { loadPushState, PUSH_STATE_VERSION, savePushState } from '../push/state'
import { SETUP_FILE, writeSetup } from '../setup'

const SECRET = 'the operator’s own secret'

let gateway: FakeGateway
let staticDir: string

/** A state directory with a full set of everything a reset has to consider. */
async function seed(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-reset-state-'))

  await saveAdminState(stateDir, {
    ...emptyAdminState(),
    admins: ['ada@example.invalid'],
    localAdmin: hashLocalSecret(SECRET),
    branding: { name: 'Acme Chat', accent: 'violet', theme: 'slate' },
    cache: { retentionHours: 48 },
    users: {
      'ada@example.invalid': {
        userId: 'ada@example.invalid',
        displayName: 'Ada Lovelace',
        email: 'ada@example.invalid',
        seenAt: 1_700_000_000,
        allowedBots: ['researcher'],
        readOnly: true,
        pushAllowed: false
      }
    }
  })
  await savePushState(stateDir, {
    v: PUSH_STATE_VERSION,
    seq: { 'a-session': 7 },
    sent: {},
    invalid: {},
    tickets: [],
    vapid: { publicKey: 'a-public-key', privateKey: 'a-private-key' },
    oidc: { refreshToken: 'the-service-login', provider: 'self-hosted', gateway: 'http://gateway.invalid' }
  })

  return stateDir
}

/** Sign in with the local secret and come back with the session cookie. */
async function signIn(web: HermieWebServer): Promise<string> {
  const page = await fetch(`${web.url}/admin`)
  const csrf = decodeURIComponent(/hermie_admin_csrf=([^;,]*)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '')

  await page.text()

  const response = await fetch(`${web.url}/admin/sign-in`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: `hermie_admin_csrf=${encodeURIComponent(csrf)}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ csrf, secret: SECRET }).toString()
  })
  const session = new RegExp(`${ADMIN_SESSION_COOKIE}=([^;,]*)`).exec(
    (response.headers.getSetCookie?.() ?? []).join(',') || (response.headers.get('set-cookie') ?? '')
  )?.[1]

  return `${ADMIN_SESSION_COOKIE}=${session ?? ''}`
}

/** Open a page as that session, taking the token it minted with it. */
async function open(web: HermieWebServer, cookie: string, at: string): Promise<{ body: string; cookie: string }> {
  const response = await fetch(`${web.url}${at}`, { headers: { cookie } })
  const body = await response.text()
  const csrf = decodeURIComponent(
    /hermie_admin_csrf=([^;,]*)/.exec((response.headers.getSetCookie?.() ?? []).join(',') || '')?.[1] ?? ''
  )

  return { body, cookie: `${cookie}; hermie_admin_csrf=${encodeURIComponent(csrf)}` }
}

async function post(
  web: HermieWebServer,
  cookie: string,
  fields: Record<string, string>
): Promise<{ status: number; location: string; body: string }> {
  const page = await open(web, cookie, '/admin/danger')
  const csrf = decodeURIComponent(/hermie_admin_csrf=([^;]*)/.exec(page.cookie)?.[1] ?? '')
  const response = await fetch(`${web.url}/admin/reset-setup`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields }).toString()
  })

  return { status: response.status, location: response.headers.get('location') ?? '', body: await response.text() }
}

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-reset-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  gateway = await startFakeGateway({ port: 0, auth: 'none' })
})

afterAll(async () => {
  await gateway.close()
})

describe('a deployment that was set up through /setup', () => {
  let web: HermieWebServer
  let stateDir: string
  let cookie: string

  beforeAll(async () => {
    stateDir = await seed()
    // The saved gateway, which is what makes this a setup-configured start.
    await writeSetup(stateDir, { gatewayUrl: gateway.url, publicUrl: '', savedAt: 1_700_000_000 })

    web = await startHermieWeb({ port: 0, staticDir, stateDir, version: '9.9.9', selfUpdate: false, env: {} })
    cookie = await signIn(web)
  })

  afterAll(async () => {
    await web.close()
  })

  it('offers the reset on the danger page and nowhere else', async () => {
    const danger = await open(web, cookie, '/admin/danger')
    const overview = await open(web, cookie, '/admin')

    expect(danger.body).toContain('Run setup again')
    expect(danger.body).toContain('action="/admin/reset-setup"')
    expect(overview.body).not.toContain('action="/admin/reset-setup"')
  })

  it('asks again, listing what goes and what stays, and changes nothing yet', async () => {
    const asked = await post(web, cookie, {})

    expect(asked.status).toBe(200)
    expect(asked.body).toContain('Reset the setup?')
    expect(asked.body).toContain('Yes, reset the setup')
    // The one thing an operator most needs to know before pressing it.
    expect(asked.body).toContain('including your own way back into')
    // And the one thing it will not touch.
    expect(asked.body).toContain('The built-in identity provider')
    expect(asked.body).toContain('<input type="hidden" name="confirm" value="1">')

    // Nothing has happened: the state is exactly as it was.
    expect((await loadAdminState(stateDir)).branding.name).toBe('Acme Chat')
    expect((await readFile(path.join(stateDir, SETUP_FILE), 'utf8')).length).toBeGreaterThan(0)
  })

  it('carries the ticked boxes into the confirmation rather than losing them', async () => {
    const asked = await post(web, cookie, { alsoCache: '1' })

    expect(asked.body).toContain('<input type="hidden" name="alsoCache" value="1">')
    expect(asked.body).not.toContain('<input type="hidden" name="alsoPush" value="1">')
  })

  it('refuses the confirmed post with no token, before it reads the body', async () => {
    const response = await fetch(`${web.url}/admin/reset-setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirm: '1' }).toString()
    })

    expect(response.status).toBe(403)
    expect((await loadAdminState(stateDir)).branding.name).toBe('Acme Chat')
  })

  it('clears the setup, the administration and the service login, and reopens /setup', async () => {
    const done = await post(web, cookie, { confirm: '1' })

    expect(done.status).toBe(303)
    expect(done.location).toBe('/setup')

    const state = await loadAdminState(stateDir)

    expect(state.admins).toEqual([])
    expect(state.localAdmin).toBeUndefined()
    expect(state.branding).toEqual({ name: '', accent: '', theme: '' })
    expect(state.cache.retentionHours).toBe(0)
    expect(state.users).toEqual({})

    // The saved gateway is gone from the disk, and the page it belongs to is open.
    await expect(readFile(path.join(stateDir, SETUP_FILE), 'utf8')).rejects.toThrow()
    expect((await fetch(`${web.url}/setup`)).status).toBe(200)

    // The service login is gone; the VAPID key and the bookkeeping are not,
    // because the box for those was not ticked.
    const push = await loadPushState(stateDir)

    expect(push.oidc).toBeUndefined()
    expect(push.vapid?.publicKey).toBe('a-public-key')
    expect(push.seq['a-session']).toBe(7)
  })

  it('leaves nobody able to open /admin, which is the point of sending them to /setup', async () => {
    const refused = await fetch(`${web.url}/admin`, { headers: { cookie } })

    // No gateway any more, so the router answers before the gate is reached.
    expect([403, 503]).toContain(refused.status)
    expect(await refused.text()).not.toContain('Run setup again')
  })
})

describe('a deployment whose gateway is on the command line', () => {
  let web: HermieWebServer
  let stateDir: string
  let cookie: string

  beforeAll(async () => {
    stateDir = await seed()
    web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir,
      stateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })
    cookie = await signIn(web)
  })

  afterAll(async () => {
    await web.close()
  })

  it('says beforehand that /setup will stay closed, and why', async () => {
    const asked = await post(web, cookie, {})

    expect(asked.body).toContain('gateway on the command line')
    expect(asked.body).not.toContain('is open again and this page is closed')
  })

  it('clears everything else and keeps the gateway it was started with', async () => {
    const done = await post(web, cookie, { confirm: '1', alsoCache: '1', alsoPush: '1' })

    expect(done.status).toBe(303)
    expect(done.location).toMatch(/^\/admin\?notice=/)
    expect(decodeURIComponent(done.location)).toContain('stays closed')

    expect((await loadAdminState(stateDir)).admins).toEqual([])
    expect((await fetch(`${web.url}/setup`)).status).toBe(404)

    // Both boxes ticked: the key and the bookkeeping went with the rest.
    const push = await loadPushState(stateDir)

    expect(push.vapid).toBeUndefined()
    expect(push.seq).toEqual({})
    expect(push.oidc).toBeUndefined()
  })
})
