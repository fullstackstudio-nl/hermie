/**
 * `/admin`: the gate, the forms, and what the per-user options actually do.
 *
 * Everything runs against the real server and the real fake gateway with cookie
 * auth and two accounts, because the whole feature is about telling two people
 * apart and a test with one person in it proves nothing.
 *
 * The four things worth pinning, in the order a reader would doubt them:
 *
 *  1. **The gate.** A signed-in reader who is not on the list gets 403, and one
 *     who is not signed in at all gets the same — never the page.
 *  2. **The token.** A POST with no CSRF token is refused before its body is
 *     read, whoever sent it.
 *  3. **The round trip.** Each form writes what it says and the page shows it
 *     back, which is the difference between a settings page and a form.
 *  4. **The enforcement.** Read-only refuses a mutating proxied request, and a
 *     bot somebody may not reach is not served out of the message cache.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { adminStatePath, emptyAdminState, loadAdminState, saveAdminState } from './state'

const ADA = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
const GRACE = { username: 'grace', password: 'hopper1', userId: 'grace@example.invalid', displayName: 'Grace Hopper' }

let gateway: FakeGateway
let web: HermieWebServer
let stateDir: string

async function signIn(account: { username: string; password: string }): Promise<string> {
  const login = await fetch(`${web.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'self-hosted', ...account, next: '/' })
  })

  return (login.headers.get('set-cookie') ?? '').split(';')[0] as string
}

/**
 * Open one administration page and come back with it and the token it minted.
 *
 * The path is a parameter because `/admin` is a set of pages now: a control is
 * on the page it belongs to, so a test that asserts a saved value has to ask for
 * that page rather than for the overview.
 */
async function openAdmin(
  cookie: string,
  path = '/admin'
): Promise<{ status: number; body: string; csrf: string; cookie: string }> {
  const response = await fetch(`${web.url}${path}`, { headers: { cookie } as Record<string, string> })
  const body = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const csrf = decodeURIComponent(/hermie_admin_csrf=([^;]*)/.exec(setCookie)?.[1] ?? '')

  return { status: response.status, body, csrf, cookie: csrf ? `${cookie}; hermie_admin_csrf=${csrf}` : cookie }
}

async function post(cookie: string, route: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${web.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    body: new URLSearchParams(fields).toString()
  })
}

beforeAll(async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-admin-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-admin-state-'))

  /*
    Ada is the operator, and the file is seeded BEFORE the server starts.

    In a real deployment `/setup` writes this when she saves; here the server is
    started with a `--gateway`, so `/setup` is already closed. It has to be
    before the start because the server reads this file once and is then the one
    authority on it for the life of the process — which is the fix for a race
    this test used to have.
  */
  await saveAdminState(stateDir, { ...emptyAdminState(), admins: [ADA.userId] })

  gateway = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [ADA, GRACE], streamDelayMs: 1 })
  web = await startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    staticDir,
    stateDir,
    version: '9.9.9',
    selfUpdate: false,
    env: {}
  })
})

afterAll(async () => {
  await web.close()
  await gateway.close()
})

describe('the gate', () => {
  it('refuses somebody who is not signed in at all', async () => {
    const response = await fetch(`${web.url}/admin`)

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('Not an administrator')
  })

  it('refuses a signed-in reader who is not on the list, and names the id it checked', async () => {
    const cookie = await signIn(GRACE)
    const response = await fetch(`${web.url}/admin`, { headers: { cookie } as Record<string, string> })
    const body = await response.text()

    expect(response.status).toBe(403)
    expect(body).toContain(GRACE.userId)
    // Nothing about the page is leaked to somebody who may not see it.
    expect(body).not.toContain('Administration</h1>')
  })

  it('lets the administrator in and mints a token for the forms', async () => {
    const page = await openAdmin(await signIn(ADA))

    expect(page.status).toBe(200)
    expect(page.body).toContain('Administration')
    expect(page.csrf.length).toBeGreaterThan(10)
  })

  it('answers in the language the browser asked for, whether it lets you in or turns you away', async () => {
    const turnedAway = await fetch(`${web.url}/admin`, { headers: { 'accept-language': 'nl' } })
    const refusal = await turnedAway.text()

    expect(turnedAway.status).toBe(403)
    expect(refusal).toContain('<html lang="nl">')
    expect(refusal).toContain('Geen beheerder')

    const letIn = await fetch(`${web.url}/admin`, {
      headers: { cookie: await signIn(ADA), 'accept-language': 'de-DE,de;q=0.9' } as Record<string, string>
    })
    const page = await letIn.text()

    expect(letIn.status).toBe(200)
    expect(page).toContain('<html lang="de">')
    expect(page).toContain('Verwaltung')
    // The glossary holds: push stays push, VAPID stays VAPID.
    expect(page).toContain('VAPID-Schlüssel')
  })

  it('answers English when the browser asked for nothing', async () => {
    const response = await fetch(`${web.url}/admin`, {
      headers: { cookie: await signIn(ADA) } as Record<string, string>
    })
    const page = await response.text()

    expect(page).toContain('<html lang="en">')
    expect(page).toContain('Administration')
  })

  it('echoes no secret of any kind', async () => {
    const page = await openAdmin(await signIn(ADA))

    // The VAPID private key, the refresh token and the local secret all live in
    // the state directory this process is reading; none may reach the page.
    expect(page.body).not.toContain('refreshToken')
    expect(page.body).not.toContain('privateKey')
    expect(page.body).not.toMatch(/hermie_admin_session=/u)
  })
})

describe('the CSRF token', () => {
  it('refuses a post that carries none', async () => {
    const cookie = await signIn(ADA)
    const response = await post(cookie, '/admin/flags', { userChats: '1' })

    expect(response.status).toBe(403)
  })

  it('refuses a post whose token is not the one in the cookie', async () => {
    const page = await openAdmin(await signIn(ADA))
    const response = await post(page.cookie, '/admin/flags', { csrf: 'not-the-token', userChats: '1' })

    expect(response.status).toBe(403)
  })
})

describe('the settings round trip', () => {
  it('writes push types and the preview policy', async () => {
    const page = await openAdmin(await signIn(ADA))
    const response = await post(page.cookie, '/admin/push', {
      csrf: page.csrf,
      'type-message': '1',
      'type-request': '1',
      preview: 'never'
    })

    expect(response.status).toBe(303)

    const state = await loadAdminState(stateDir)

    expect(state.push.types).toMatchObject({ message: true, request: true, dm: false, cron: false })
    expect(state.push.preview).toBe('never')

    const after = await openAdmin(page.cookie, '/admin/push')

    expect(after.body).toContain('<option value="never" selected>')
  })

  it('writes cache retention', async () => {
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/cache', { csrf: page.csrf, retentionHours: '48' })

    expect((await loadAdminState(stateDir)).cache.retentionHours).toBe(48)
    expect((await openAdmin(page.cookie, '/admin/cache')).body).toContain('value="48"')
  })

  it('writes branding, and it reaches the app bootstrap', async () => {
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/branding', { csrf: page.csrf, name: 'Acme Chat', accent: 'violet', theme: 'slate' })

    const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as {
      branding?: { name?: string; accent?: string; theme?: string }
    }

    expect(config.branding).toEqual({ name: 'Acme Chat', accent: 'violet', theme: 'slate' })
  })

  it('writes feature flags, and the bootstrap carries them', async () => {
    const page = await openAdmin(await signIn(ADA))

    // Only `messageCache` ticked: an unticked checkbox sends nothing, which is
    // how an HTML form says "off" and the reason the reader is a whitelist.
    await post(page.cookie, '/admin/flags', { csrf: page.csrf, messageCache: '1' })

    const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as {
      flags?: { userChats?: boolean; messageCache?: boolean; selfUpdate?: boolean }
      service?: { cache?: boolean }
    }

    expect(config.flags).toMatchObject({ userChats: false, messageCache: true, selfUpdate: false })

    // And put them back, because everything after this shares the server.
    await post(page.cookie, '/admin/flags', {
      csrf: page.csrf,
      userChats: '1',
      messageCache: '1',
      selfUpdate: '1'
    })
  })

  it('turning the cache flag off closes the route without deleting anything', async () => {
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/flags', { csrf: page.csrf, userChats: '1', selfUpdate: '1' })

    const refused = await fetch(`${web.url}/hermie/cache/researcher`, {
      headers: { cookie: page.cookie } as Record<string, string>
    })

    expect(refused.status).toBe(404)
    expect((await refused.json()) as { error: string }).toMatchObject({ error: 'cache_disabled' })

    await post(page.cookie, '/admin/flags', {
      csrf: page.csrf,
      userChats: '1',
      messageCache: '1',
      selfUpdate: '1'
    })
  })

  it('stores the state 0600, so a transcript-adjacent file is not world readable', async () => {
    const { mode } = await import('node:fs/promises').then(fs => fs.stat(adminStatePath(stateDir)))

    expect(mode & 0o777).toBe(0o600)
  })
})

describe('the people list', () => {
  it('notes everybody the service has seen, with when', async () => {
    const grace = await signIn(GRACE)

    // Any proxied request is enough; the roster read is what a page load makes.
    await fetch(`${web.url}/api/auth/me`, { headers: { cookie: grace } as Record<string, string> })

    const page = await openAdmin(await signIn(ADA), '/admin/people')

    expect(page.body).toContain(GRACE.userId)
    expect(page.body).toContain('Grace Hopper')
  })

  it('saves one person’s options and shows them back', async () => {
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/user', {
      csrf: page.csrf,
      userId: GRACE.userId,
      allowedBots: 'researcher, notes',
      readOnly: '1'
    })

    const state = await loadAdminState(stateDir)

    expect(state.users[GRACE.userId]).toMatchObject({
      allowedBots: ['researcher', 'notes'],
      readOnly: true,
      // Unticked: an HTML form sends nothing for it, which is "off".
      pushAllowed: false
    })
    expect((await openAdmin(page.cookie, '/admin/people')).body).toContain('researcher, notes')
  })

  it('refuses to remove the last administrator', async () => {
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/user', { csrf: page.csrf, userId: ADA.userId, pushAllowed: '1' })

    const state = await loadAdminState(stateDir)

    expect(state.admins).toEqual([ADA.userId])
  })
})

describe('what the options enforce', () => {
  it('refuses a read-only reader’s mutating request through the proxy', async () => {
    const grace = await signIn(GRACE)
    const page = await openAdmin(await signIn(ADA))

    await post(page.cookie, '/admin/user', { csrf: page.csrf, userId: GRACE.userId, readOnly: '1' })

    const refused = await fetch(`${web.url}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { cookie: grace, 'content-type': 'application/json' } as Record<string, string>,
      body: '{}'
    })

    expect(refused.status).toBe(403)
    expect((await refused.json()) as { error: string }).toMatchObject({ error: 'read_only' })

    // Reading is untouched, which is the whole of what "read-only" means here.
    const read = await fetch(`${web.url}/api/auth/me`, { headers: { cookie: grace } as Record<string, string> })

    expect(read.status).toBe(200)
  })

  it('leaves everybody else’s mutating requests alone', async () => {
    const ada = await signIn(ADA)
    const minted = await fetch(`${web.url}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { cookie: ada, 'content-type': 'application/json' } as Record<string, string>,
      body: '{}'
    })

    expect(minted.status).toBe(200)
  })

  it('does not serve a bot out of the cache to somebody who may not reach it', async () => {
    const grace = await signIn(GRACE)
    const page = await openAdmin(await signIn(ADA))

    // `notes` only: `researcher` is now out of reach for Grace.
    await post(page.cookie, '/admin/user', { csrf: page.csrf, userId: GRACE.userId, allowedBots: 'notes' })

    await web.cache.put({
      sessionId: 'stored-shared-researcher',
      bot: 'researcher',
      owner: '',
      storedId: 'stored-shared-researcher',
      shape: 'rpc',
      rows: [{ role: 'assistant', row_id: 1, text: 'shared' }],
      updatedAt: 1
    })

    const theirs = await fetch(`${web.url}/hermie/cache/researcher`, {
      headers: { cookie: grace } as Record<string, string>
    })

    expect(theirs.status).toBe(404)

    // And the administrator, who has no allow list, still gets it.
    const mine = await fetch(`${web.url}/hermie/cache/researcher`, {
      headers: { cookie: await signIn(ADA) } as Record<string, string>
    })

    expect(mine.status).toBe(200)
  })

  it('keeps the state file readable as JSON after every write', async () => {
    const parsed = JSON.parse(await readFile(adminStatePath(stateDir), 'utf8')) as { v: number }

    expect(parsed.v).toBe(1)
  })
})

/**
 * The chrome, and the fact that there is now more than one page behind it.
 *
 * What is worth pinning is not that the CSS is there. It is that every page
 * carries the nav and marks the one it is, that a path nobody serves says so
 * rather than quietly drawing the overview, and that each control still lives on
 * exactly one page — which is the whole of what the restructure bought.
 */
describe('the administration pages', () => {
  const PAGES = ['/admin', '/admin/people', '/admin/push', '/admin/cache', '/admin/branding', '/admin/features']

  it('draws every page with the same chrome, the mark and the version in the footer', async () => {
    const cookie = await signIn(ADA)

    for (const path of [...PAGES, '/admin/danger', '/admin/oidc']) {
      const page = await openAdmin(cookie, path)

      expect(page.status, path).toBe(200)
      // The logo is inlined, so a page an operator opens when something is
      // already wrong needs no second request to look like itself.
      expect(page.body, path).toContain('<svg class="mark"')
      expect(page.body, path).toContain('href="/admin/oidc"')
      expect(page.body, path).toContain('Hermie Web 9.9.9')
      // One nav, with one current entry. Anchored to the link, because the
      // style sheet names the same attribute in a selector.
      expect(page.body.match(/<a href="[^"]*" aria-current="page">/g), path).toHaveLength(1)
      // And no script, on any of them.
      expect(page.body, path).not.toContain('<script')
    }
  })

  it('marks the page the reader is on, and nothing else', async () => {
    const cookie = await signIn(ADA)
    const push = await openAdmin(cookie, '/admin/push')

    expect(push.body).toContain('<a href="/admin/push" aria-current="page">')
    expect(push.body).toContain('<a href="/admin/cache">')
  })

  it('puts each control on exactly one page', async () => {
    const cookie = await signIn(ADA)
    const bodies = new Map<string, string>()

    for (const path of PAGES) {
      bodies.set(path, (await openAdmin(cookie, path)).body)
    }

    const hasForm = (path: string, action: string): boolean => (bodies.get(path) ?? '').includes(`action="${action}"`)

    expect(hasForm('/admin/push', '/admin/push')).toBe(true)
    expect(hasForm('/admin', '/admin/push')).toBe(false)
    expect(hasForm('/admin/cache', '/admin/cache')).toBe(true)
    expect(hasForm('/admin/branding', '/admin/branding')).toBe(true)
    expect(hasForm('/admin/features', '/admin/flags')).toBe(true)
    expect(hasForm('/admin/people', '/admin/user')).toBe(true)
    expect(hasForm('/admin', '/admin/user')).toBe(false)
  })

  it('sends a saved form back to the page it was on', async () => {
    const page = await openAdmin(await signIn(ADA), '/admin/branding')
    const response = await post(page.cookie, '/admin/branding', {
      csrf: page.csrf,
      name: 'Acme Chat',
      accent: '',
      theme: ''
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toMatch(/^\/admin\/branding\?notice=/)
  })

  it('names the deployment rather than Hermie once branding has one', async () => {
    const page = await openAdmin(await signIn(ADA))

    expect(page.body).toContain('<span class="brand-name">Acme Chat</span>')
    expect(page.body).toContain('<title>Overview — Acme Chat</title>')
  })

  it('answers 404 for an /admin path nobody serves, rather than drawing the overview', async () => {
    const response = await fetch(`${web.url}/admin/nowhere`, {
      headers: { cookie: await signIn(ADA) } as Record<string, string>
    })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<svg class="mark"')
  })

  it('translates the nav, so a page is not half in one language', async () => {
    const response = await fetch(`${web.url}/admin/people`, {
      headers: { cookie: await signIn(ADA), 'accept-language': 'nl' } as Record<string, string>
    })
    const body = await response.text()

    expect(body).toContain('<html lang="nl">')
    expect(body).toContain('>Overzicht</a>')
    expect(body).toContain('>Gevarenzone</a>')
    expect(body).toContain('Bijwerken en herstarten')
  })
})
