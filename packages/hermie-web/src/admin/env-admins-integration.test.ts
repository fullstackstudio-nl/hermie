/**
 * `HERMIE_ADMINS` end to end: applied on start, protected from removal, and
 * respectful of an administrator a person added by hand.
 *
 * Kept apart from `admin.test.ts`, which shares one server for the whole
 * file — this file's whole point is starting a fresh one, sometimes several
 * times over the same state directory, so it needs the freedom to do that
 * without disturbing anything else's fixtures.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { createAccount, enableProvider } from '../oidc/accounts'
import { emptyAdminState, loadAdminState, saveAdminState } from './state'

const ADA = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
const GRACE = { username: 'grace', password: 'hopper1', userId: 'grace@example.invalid', displayName: 'Grace Hopper' }

let gateway: FakeGateway
let staticDir: string
let stateDir: string

async function signIn(web: HermieWebServer, account: { username: string; password: string }): Promise<string> {
  const login = await fetch(`${web.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'self-hosted', ...account, next: '/' })
  })

  return (login.headers.get('set-cookie') ?? '').split(';')[0] as string
}

async function openAdmin(
  web: HermieWebServer,
  cookie: string,
  path = '/admin'
): Promise<{ status: number; body: string; csrf: string; cookie: string }> {
  const response = await fetch(`${web.url}${path}`, { headers: { cookie } as Record<string, string> })
  const body = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const csrf = decodeURIComponent(/hermie_admin_csrf=([^;]*)/.exec(setCookie)?.[1] ?? '')

  return { status: response.status, body, csrf, cookie: csrf ? `${cookie}; hermie_admin_csrf=${csrf}` : cookie }
}

async function post(
  web: HermieWebServer,
  cookie: string,
  route: string,
  fields: Record<string, string | string[]>
): Promise<Response> {
  const body = new URLSearchParams()

  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      body.append(name, one)
    }
  }

  return fetch(`${web.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    body: body.toString()
  })
}

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-admins-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-admins-state-'))
  gateway = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [ADA, GRACE], streamDelayMs: 1 })
})

afterAll(async () => {
  await gateway.close()
})

async function start(admins: string[]): Promise<HermieWebServer> {
  return startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    staticDir,
    stateDir,
    version: '9.9.9',
    selfUpdate: false,
    admins,
    env: {}
  })
}

describe('HERMIE_ADMINS', () => {
  it('is applied on start: a container-named id can reach /admin with no other setup', async () => {
    const web = await start([ADA.userId])

    try {
      const page = await openAdmin(web, await signIn(web, ADA))

      expect(page.status).toBe(200)

      const state = await loadAdminState(stateDir)

      expect(state.admins).toEqual([ADA.userId])
      // Recorded env-managed: this reconcile, on a fresh state directory, is
      // what put her there.
      expect(state.managedAdmins).toEqual([ADA.userId])
    } finally {
      await web.close()
    }
  })

  it('marks the id "set by configuration" on the people page and refuses to remove it there', async () => {
    const web = await start([ADA.userId])

    try {
      const adaCookie = await signIn(web, ADA)
      // A row on the people page exists only once this service has actually
      // seen somebody — any proxied request does it, the same way
      // `admin.test.ts`'s own people-list test triggers one.
      await fetch(`${web.url}/api/auth/me`, { headers: { cookie: adaCookie } as Record<string, string> })

      const page = await openAdmin(web, adaCookie, '/admin/people')

      expect(page.body).toContain('set by configuration')

      // Try to uncheck Administrator for Ada, the way a browser would submit
      // the form with the box cleared (and, since it would be disabled in a
      // real browser, this is also the "somebody stripped the attribute"
      // case the server itself has to refuse).
      await post(web, page.cookie, '/admin/user', { csrf: page.csrf, userId: ADA.userId, pushAllowed: '1' })

      const state = await loadAdminState(stateDir)

      expect(state.admins).toEqual([ADA.userId])
    } finally {
      await web.close()
    }
  })

  it('leaves a manually-added administrator alone across a restart, and drops only the env-only one', async () => {
    // Start 1: the container names Ada.
    let web = await start([ADA.userId])
    const adaCookie = await signIn(web, ADA)
    const page = await openAdmin(web, adaCookie, '/admin/people')

    // Ada adds Grace by hand — a real person, using the form, exactly the
    // way `/admin/people` is meant to be used.
    await post(web, page.cookie, '/admin/user', { csrf: page.csrf, userId: GRACE.userId, admin: '1', pushAllowed: '1' })

    let state = await loadAdminState(stateDir)

    expect(state.admins.sort()).toEqual([ADA.userId, GRACE.userId].sort())
    // Grace was added by hand — `withAdmin` — so she is never recorded as
    // env-managed. Ada IS, from the very first start of this test: only ids
    // an env reconcile itself adds ever land in this list.
    expect(state.managedAdmins).toEqual([ADA.userId])

    await web.close()

    // Start 2: the same state directory, but the container no longer names
    // Ada at all.
    web = await start([])

    state = await loadAdminState(stateDir)

    // Ada was only ever here because start 1's list named her — gone.
    expect(state.admins).toEqual([GRACE.userId])

    // Grace, added by hand, is unaffected by an environment that never
    // mentioned her either way.
    const graceCookie = await signIn(web, GRACE)
    const graceOpened = await openAdmin(web, graceCookie)

    expect(graceOpened.status).toBe(200)

    // And Ada, no longer an administrator, is refused.
    const adaOpened = await openAdmin(web, await signIn(web, ADA))

    expect(adaOpened.status).toBe(403)

    await web.close()
  })

  it('lets a flag (the resolved option) win over whatever the environment would have said', async () => {
    const web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir,
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-env-admins-flag-state-')),
      version: '9.9.9',
      selfUpdate: false,
      admins: [ADA.userId],
      env: { HERMIE_ADMINS: GRACE.userId }
    })

    try {
      // `admins` on the input wins in `resolveOptions` regardless of what the
      // environment carries — this only pins that `startHermieWeb` actually
      // enforces the RESOLVED option, not a re-read of the environment.
      const adaOpened = await openAdmin(web, await signIn(web, ADA))

      expect(adaOpened.status).toBe(200)
    } finally {
      await web.close()
    }
  })
})

/**
 * `HERMIE_ADMINS` together with the built-in issuer — the interplay that used
 * to undo one or the other.
 *
 * Reproduced exactly the way it was found: `HERMIE_ADMINS=owner` naming an
 * account whose issuer ROLE is `user`, alongside `boss`, an account made an
 * administrator through `/admin/oidc`'s own role switch. Before the fix,
 * `owner` and `boss` fought over `admins` — `reconcileEnvAdmins` put `owner`
 * on it, and `reconcileIssuerPeople`, run right after, deleted any non-admin
 * ACCOUNT from `admins` with no idea `owner` was there for a different
 * reason, leaving only `boss`.
 */
describe('HERMIE_ADMINS together with the built-in issuer', () => {
  let issuerGateway: FakeGateway
  let issuerWeb: HermieWebServer
  let issuerStateDir: string
  let ownerSub = ''
  let bossSub = ''

  const OPERATOR = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada' }

  async function signInAsOperator(): Promise<string> {
    const login = await fetch(`${issuerWeb.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', ...OPERATOR, next: '/' })
    })

    return (login.headers.get('set-cookie') ?? '').split(';')[0] as string
  }

  async function openOidc(cookie: string): Promise<{ body: string; cookie: string; csrf: string }> {
    const response = await fetch(`${issuerWeb.url}/admin/oidc`, { headers: { cookie } })
    const body = await response.text()
    const csrf = decodeURIComponent(
      /hermie_admin_csrf=([^;,]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''
    )

    return { body, csrf, cookie: `${cookie}; hermie_admin_csrf=${encodeURIComponent(csrf)}` }
  }

  async function postOidc(fields: Record<string, string>): Promise<{ status: number; notice: string }> {
    const page = await openOidc(await signInAsOperator())
    const response = await fetch(`${issuerWeb.url}/admin/oidc/user`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: page.csrf, ...fields }).toString()
    })

    return {
      status: response.status,
      notice: new URL(response.headers.get('location') ?? '/', issuerWeb.url).searchParams.get('notice') ?? ''
    }
  }

  beforeAll(async () => {
    const issuerStaticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-issuer-static-'))
    await mkdir(issuerStaticDir, { recursive: true })
    await writeFile(path.join(issuerStaticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

    issuerStateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-issuer-state-'))
    // Ada is a MANUAL, gateway-native bootstrap administrator, seeded
    // directly rather than through HERMIE_ADMINS or `--admins`: this test is
    // about `owner` and `boss`, and passing Ada as a resolved `admins` value
    // for the first start would itself make her env-managed, which the
    // second start (a DIFFERENT HERMIE_ADMINS) would then drop.
    await saveAdminState(issuerStateDir, { ...emptyAdminState(), admins: [OPERATOR.userId] })

    issuerGateway = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [OPERATOR], streamDelayMs: 1 })

    /*
      HERMIE_ADMINS names a GATEWAY USER ID, not a username — for an issuer
      account that is the `sub`, an opaque string minted on creation. So the
      real sequence this reproduces is two starts, exactly as an operator
      would actually reach it: create the accounts first, read `owner`'s sub
      off `/admin/oidc`, THEN set HERMIE_ADMINS to it and restart. Start 1
      here stands in for "before HERMIE_ADMINS was set at all".
    */
    const bootstrap = await startHermieWeb({
      gatewayUrl: issuerGateway.url,
      port: 0,
      staticDir: issuerStaticDir,
      stateDir: issuerStateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })

    issuerWeb = bootstrap

    await issuerWeb.oidc.update(state =>
      enableProvider(state, {
        origin: issuerWeb.url,
        gatewayPublicUrl: 'https://hermes.example.invalid',
        allowInsecure: false
      })
    )

    await postOidc({ do: 'create', username: 'owner', role: 'user' })
    await postOidc({ do: 'create', username: 'boss', role: 'admin' })

    ownerSub = issuerWeb.oidc.users.find(user => user.username === 'owner')?.sub ?? ''
    bossSub = issuerWeb.oidc.users.find(user => user.username === 'boss')?.sub ?? ''

    expect(ownerSub).toBeTruthy()

    await bootstrap.close()

    // Start 2: the container now names `owner`'s sub — this is the exact
    // repro (`HERMIE_ADMINS=owner`, role `user`, alongside `boss`, role
    // `admin`) with "owner" read as the id it actually has to be.
    issuerWeb = await startHermieWeb({
      gatewayUrl: issuerGateway.url,
      port: 0,
      staticDir: issuerStaticDir,
      stateDir: issuerStateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: { HERMIE_ADMINS: ownerSub }
    })
  })

  afterAll(async () => {
    await issuerWeb.close()
    await issuerGateway.close()
  })

  it('names both administrators — the one HERMIE_ADMINS declared and the one a role made — at once', async () => {
    expect(ownerSub).toBeTruthy()
    expect(bossSub).toBeTruthy()

    const state = await loadAdminState(issuerStateDir)

    expect(state.admins).toContain(ownerSub)
    expect(state.admins).toContain(bossSub)
    expect(state.admins).toContain(OPERATOR.userId)
  })

  it('brings owner’s own issuer role up to admin, so /admin/oidc agrees with /admin', () => {
    expect(issuerWeb.oidc.users.find(user => user.sub === ownerSub)?.role).toBe('admin')
  })

  it('refuses to demote owner’s role back to user', async () => {
    const result = await postOidc({ do: 'role', sub: ownerSub, role: 'user' })

    expect(result.notice).toContain('set by configuration')
    expect(issuerWeb.oidc.users.find(user => user.sub === ownerSub)?.role).toBe('admin')
    expect((await loadAdminState(issuerStateDir)).admins).toContain(ownerSub)
  })

  it('refuses to disable owner’s account', async () => {
    const result = await postOidc({ do: 'disable', sub: ownerSub })

    expect(result.notice).toContain('set by configuration')
    expect(issuerWeb.oidc.users.find(user => user.sub === ownerSub)?.disabled).toBeFalsy()
  })

  it('refuses to remove owner’s account', async () => {
    const result = await postOidc({ do: 'remove', sub: ownerSub })

    expect(result.notice).toContain('set by configuration')
    expect(issuerWeb.oidc.users.find(user => user.sub === ownerSub)).toBeTruthy()
    expect((await loadAdminState(issuerStateDir)).admins).toContain(ownerSub)
  })

  it('still lets boss’s account be disabled — an ordinary, non-env-named administrator', async () => {
    const result = await postOidc({ do: 'disable', sub: bossSub })

    expect(result.notice).toContain('is disabled')
    expect(issuerWeb.oidc.users.find(user => user.sub === bossSub)?.disabled).toBe(true)

    // Restore it, so this test does not leak into whichever runs after it.
    await postOidc({ do: 'enable', sub: bossSub })
  })
})

/*
  An id leaving HERMIE_ADMINS must take back everything the container gave
  it — the issuer ROLE as well as the `admins` entry. Before this, the role
  stayed `admin` after the id left the option, and `reconcileIssuerPeople`
  added it straight back to `admins` as an ordinary, unmanaged
  administrator: a previous owner kept `/admin` for good.
*/
describe('HERMIE_ADMINS dropping an id whose issuer role it raised', () => {
  let gatewayForIssuer: FakeGateway
  let dir: string
  let staticForIssuer: string
  let ownerSub = ''
  let bossSub = ''

  const OPERATOR = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada' }

  async function startWith(env: Record<string, string>): Promise<HermieWebServer> {
    return startHermieWeb({
      gatewayUrl: gatewayForIssuer.url,
      port: 0,
      staticDir: staticForIssuer,
      stateDir: dir,
      version: '9.9.9',
      selfUpdate: false,
      env
    })
  }

  async function postRole(web: HermieWebServer, sub: string, role: 'admin' | 'user'): Promise<string> {
    const login = await fetch(`${web.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', ...OPERATOR, next: '/' })
    })
    const session = (login.headers.get('set-cookie') ?? '').split(';')[0] as string
    const page = await fetch(`${web.url}/admin/oidc`, { headers: { cookie: session } })
    const csrf = decodeURIComponent(/hermie_admin_csrf=([^;,]*)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '')
    const response = await fetch(`${web.url}/admin/oidc/user`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `${session}; hermie_admin_csrf=${encodeURIComponent(csrf)}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ csrf, do: 'role', sub, role }).toString()
    })

    return new URL(response.headers.get('location') ?? '/', web.url).searchParams.get('notice') ?? ''
  }

  const roleOf = (web: HermieWebServer, sub: string) => web.oidc.users.find(user => user.sub === sub)?.role

  beforeAll(async () => {
    staticForIssuer = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-demote-static-'))
    await writeFile(path.join(staticForIssuer, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')
    gatewayForIssuer = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [OPERATOR], streamDelayMs: 1 })
  })

  afterAll(async () => {
    await gatewayForIssuer.close()
  })

  async function freshIssuer(seedAdmins: string[]): Promise<void> {
    dir = await mkdtemp(path.join(tmpdir(), 'hermie-web-env-demote-state-'))
    await saveAdminState(dir, { ...emptyAdminState(), admins: seedAdmins })

    const web = await startWith({})

    try {
      await web.oidc.update(state =>
        enableProvider(state, {
          origin: web.url,
          gatewayPublicUrl: 'https://hermes.example.invalid',
          allowInsecure: false
        })
      )
      await web.oidc.update(
        state => createAccount(state, { username: 'owner', email: '', displayName: '', role: 'user' }).state
      )
      await web.oidc.update(
        state => createAccount(state, { username: 'boss', email: '', displayName: '', role: 'admin' }).state
      )

      ownerSub = web.oidc.users.find(user => user.username === 'owner')?.sub ?? ''
      bossSub = web.oidc.users.find(user => user.username === 'boss')?.sub ?? ''
    } finally {
      await web.close()
    }
  }

  it('demotes the role back to user, and drops the id, once the container stops naming it', async () => {
    await freshIssuer([])

    const named = await startWith({ HERMIE_ADMINS: ownerSub })

    try {
      const state = await loadAdminState(dir)

      expect(state.admins).toEqual([bossSub, ownerSub].sort())
      expect(state.managedAdmins).toEqual([ownerSub])
      expect(roleOf(named, ownerSub)).toBe('admin')
    } finally {
      await named.close()
    }

    const dropped = await startWith({})

    try {
      const state = await loadAdminState(dir)

      expect(roleOf(dropped, ownerSub)).toBe('user')
      expect(state.admins).toEqual([bossSub])
      expect(state.managedAdmins).toEqual([])
      // An ordinary administrator's role is nobody's business but a person's.
      expect(roleOf(dropped, bossSub)).toBe('admin')
    } finally {
      await dropped.close()
    }
  })

  it('keeps the role when a person set it to admin themselves while the container named the id', async () => {
    await freshIssuer([OPERATOR.userId])

    const named = await startWith({ HERMIE_ADMINS: ownerSub })

    try {
      expect(roleOf(named, ownerSub)).toBe('admin')
      expect(await postRole(named, ownerSub, 'admin')).toBe('Saved.')
    } finally {
      await named.close()
    }

    const dropped = await startWith({})

    try {
      expect(roleOf(dropped, ownerSub)).toBe('admin')
      expect((await loadAdminState(dir)).admins).toContain(ownerSub)
    } finally {
      await dropped.close()
    }
  })

  it('leaves a role that was already admin before the container named the id', async () => {
    await freshIssuer([])

    const named = await startWith({ HERMIE_ADMINS: bossSub })

    await named.close()

    const dropped = await startWith({})

    try {
      expect(roleOf(dropped, bossSub)).toBe('admin')
      expect((await loadAdminState(dir)).admins).toEqual([bossSub])
    } finally {
      await dropped.close()
    }
  })
})
