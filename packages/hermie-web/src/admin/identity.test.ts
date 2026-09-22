/**
 * `/admin/oidc`: turning the provider on, running it, and the one thing the
 * page must never claim.
 *
 * Everything runs against the real server and the real fake gateway with two
 * accounts, the same arrangement `admin.test.ts` uses, because the gate on this
 * page is the same gate and a test with one person in it proves nothing about
 * it.
 *
 * The test sign-in is not mocked. It runs the round trip over the loopback
 * interface against the server's own issuer, which is the entire point of that
 * button: a mocked one would pass on a deployment where `/oidc` is not
 * reachable at all, which is the failure it exists to find.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { emptyAdminState, saveAdminState } from './state'
import { totpAt } from '../oidc/totp'

const ADA = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }
const GRACE = { username: 'grace', password: 'hopper1', userId: 'grace@example.invalid', displayName: 'Grace Hopper' }

let gateway: FakeGateway
let web: HermieWebServer

/** Sign in to the FAKE GATEWAY, which is what the `/admin` gate checks. */
async function signInToGateway(account: { username: string; password: string }): Promise<string> {
  const login = await fetch(`${web.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'self-hosted', ...account, next: '/' })
  })

  return (login.headers.get('set-cookie') ?? '').split(';')[0] as string
}

/** Open `/admin/oidc` and come back with the page and the token it minted. */
async function openIdentity(cookie: string): Promise<{ status: number; body: string; csrf: string; cookie: string }> {
  const response = await fetch(`${web.url}/admin/oidc`, { headers: { cookie } })
  const body = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const csrf = decodeURIComponent(/hermie_admin_csrf=([^;,]*)/.exec(setCookie)?.[1] ?? '')

  return { status: response.status, body, csrf, cookie: csrf ? `${cookie}; hermie_admin_csrf=${csrf}` : cookie }
}

/** Post one of the page's forms and follow the redirect back to it. */
async function post(
  adminCookie: string,
  route: string,
  fields: Record<string, string>
): Promise<{ status: number; notice: string; page: string }> {
  const page = await openIdentity(adminCookie)
  const response = await fetch(`${web.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: page.csrf, ...fields }).toString()
  })
  const location = response.headers.get('location') ?? ''
  const notice = new URL(location, web.url).searchParams.get('notice') ?? ''

  return { status: response.status, notice, page: (await openIdentity(adminCookie)).body }
}

beforeAll(async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-identity-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  const stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-identity-state-'))
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

describe('the gate is the same gate', () => {
  it('refuses somebody who is not an administrator of this service', async () => {
    const response = await fetch(`${web.url}/admin/oidc`, { headers: { cookie: await signInToGateway(GRACE) } })

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('The built-in identity provider')
  })

  it('refuses a POST with no token before it reads the body', async () => {
    const response = await fetch(`${web.url}/admin/oidc/enable`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: await signInToGateway(ADA), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ enabled: '1' }).toString()
    })

    expect(response.status).toBe(403)
    expect(web.oidc.enabled).toBe(false)
  })
})

describe('the language is negotiated here too', () => {
  /*
    This page was the last one still hard-coded to English, which is the one
    place it actually mattered: an operator reading `/admin` in Dutch follows
    the "Identiteitsinstellingen …" link and would have landed in English
    halfway through the one flow on this service that has a middle.
  */
  it('answers /admin/oidc in the language the browser asked for, and English when it asked for nothing', async () => {
    const cookie = await signInToGateway(ADA)
    const asked = await fetch(`${web.url}/admin/oidc`, { headers: { cookie, 'accept-language': 'nl-NL,nl;q=0.9' } })
    const dutch = await asked.text()

    expect(asked.status).toBe(200)
    expect(dutch).toContain('<html lang="nl">')
    expect(dutch).toContain('<h1>Identiteit</h1>')
    expect(dutch).toContain('De ingebouwde identity provider')
    // The glossary holds: gateway stays gateway even in the middle of a Dutch
    // sentence, and so does every path.
    expect(dutch).toContain('identiteitswortel van je gateway')
    expect(dutch).toContain('href="/admin"')

    const silent = await fetch(`${web.url}/admin/oidc`, { headers: { cookie } })
    const english = await silent.text()

    expect(silent.status).toBe(200)
    expect(english).toContain('<html lang="en">')
    expect(english).toContain('The built-in identity provider')
  })
})

describe('turning it on', () => {
  it('starts off, and says so on both pages', async () => {
    const cookie = await signInToGateway(ADA)
    const identity = await openIdentity(cookie)
    const main = await fetch(`${web.url}/admin`, { headers: { cookie } })

    expect(identity.status).toBe(200)
    expect(identity.body).toContain('The built-in identity provider')
    expect(identity.body).toContain('Turn it on')
    // The guide and the account list do not exist until there is an issuer.
    expect(identity.body).not.toContain('What to put in the gateway')
    expect(await main.text()).toContain('It is <strong>off</strong>')
  })

  it('mints an issuer, a key and a client id from the origin the operator used', async () => {
    const cookie = await signInToGateway(ADA)
    const result = await post(cookie, '/admin/oidc/enable', { enabled: '1' })

    expect(result.status).toBe(303)
    expect(web.oidc.enabled).toBe(true)
    // The issuer is the origin this page was reached on, with /oidc on it.
    expect(web.oidc.issuer).toBe(`${web.url}/oidc`)
    expect(web.oidc.clientId).toMatch(/^hermie-web-[0-9a-f]{16}$/)
    expect(result.notice).toContain('changed nothing on the gateway')
  })

  it('serves discovery and a JWKS the moment it is on', async () => {
    const discovery = (await (await fetch(`${web.url}/oidc/.well-known/openid-configuration`)).json()) as Record<
      string,
      string
    >

    expect(discovery.issuer).toBe(`${web.url}/oidc`)
    expect(((await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: unknown[] }).keys).toHaveLength(1)
  })

  it('prints the gateway snippet with this deployment’s real values', async () => {
    const { body } = await openIdentity(await signInToGateway(ADA))

    expect(body).toContain('dashboard:')
    expect(body).toContain('    self_hosted:')
    expect(body).toContain(`      issuer: ${web.url}/oidc`)
    expect(body).toContain(`      client_id: ${web.oidc.clientId}`)
    // Without it, this service's own push sign-in cannot be made at all.
    expect(body).toContain('scopes: openid profile email offline_access')
    // And the environment-variable form, for a container.
    expect(body).toContain(`HERMES_DASHBOARD_OIDC_ISSUER=${web.url}/oidc`)
  })

  it('registers the gateway’s own callback, built from its public url', async () => {
    const { body } = await openIdentity(await signInToGateway(ADA))

    // Upstream builds the redirect URI out of `dashboard.public_url` and
    // refuses any whose path does not end `/auth/callback`.
    expect(body).toContain(`${new URL(gateway.url).origin}/auth/callback`)
    // And it says why the phone's loopback URI is not registered here.
    expect(body).toContain('The redirect URI is the gateway’s, not the app’s.')
  })

  it('says out loud that this makes the service the identity root', async () => {
    const cookie = await signInToGateway(ADA)

    expect((await openIdentity(cookie)).body).toContain('identity root of your gateway')
    expect(await (await fetch(`${web.url}/admin`, { headers: { cookie } })).text()).toContain(
      'identity root of your gateway'
    )
  })
})

describe('accounts', () => {
  let inviteLink = ''

  it('creates somebody with an invitation rather than a password', async () => {
    const result = await post(await signInToGateway(ADA), '/admin/oidc/user', {
      do: 'create',
      username: 'katherine',
      email: 'katherine@example.invalid',
      displayName: 'Katherine Johnson',
      role: 'user'
    })

    expect(result.notice).toContain('katherine was created')
    // The link is rendered on the page it redirects to, once.
    expect(result.page).toContain('/oidc/invite?token=')

    inviteLink = /<code>([^<]*\/oidc\/invite\?token=[^<]*)<\/code>/.exec(result.page)?.[1] ?? ''

    expect(inviteLink).toBeTruthy()
  })

  it('shows the invitation exactly once', async () => {
    const { body } = await openIdentity(await signInToGateway(ADA))

    // The next render does not carry it: it is held in memory and cleared as
    // it is drawn, never put in the redirect's query string.
    expect(body).not.toContain('/oidc/invite?token=')
    expect(body).toContain('katherine')
  })

  it('lets them choose their own password through the link, once', async () => {
    const page = await fetch(inviteLink.replace(/&amp;/g, '&'))
    const body = await page.text()
    const csrf = decodeURIComponent(/hermie_oidc_csrf=([^;,]*)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '')
    const token = /name="token" value="([^"]*)"/.exec(body)?.[1] ?? ''

    expect(page.status).toBe(200)
    expect(body).toContain('Choose a password')

    const submit = (password: string, confirm = password) =>
      fetch(`${web.url}/oidc/invite`, {
        method: 'POST',
        headers: {
          cookie: `hermie_oidc_csrf=${encodeURIComponent(csrf)}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ csrf, token, password, confirm }).toString()
      })

    // Length is the rule, and a mismatch is caught before anything is stored.
    expect(await (await submit('short')).text()).toContain('at least twelve characters')
    expect(await (await submit('a long enough password', 'a different one')).text()).toContain('did not match')

    const done = await submit('katherine’s own password')
    const confirmation = await done.text()

    expect(done.status).toBe(200)
    /*
      The page that reports it says so.

      This used to be the ERROR page: the sentence under the heading said the
      password was set and the heading above it read "Sign-in failed", so
      somebody who had just done exactly what they were asked was told they had
      failed. The heading is the assertion, and the absence of the other one is
      the regression guard.
    */
    expect(confirmation).toContain('<h1>Your password is set</h1>')
    expect(confirmation).not.toContain('Sign-in failed')
    // And a way onward, on this origin, named after the deployment.
    expect(confirmation).toContain('<a href="/">Back to Hermie Web</a>')

    // The link is spent: it cannot set a second password.
    expect(await (await submit('somebody else’s password')).text()).toContain('has been used or has expired')
  })

  it('says the password is set in the language the reader’s browser asked for', async () => {
    const created = await post(await signInToGateway(ADA), '/admin/oidc/user', {
      do: 'create',
      username: 'mary',
      role: 'user'
    })
    const link = (/<code>([^<]*\/oidc\/invite\?token=[^<]*)<\/code>/.exec(created.page)?.[1] ?? '').replace(
      /&amp;/g,
      '&'
    )
    const page = await fetch(link, { headers: { 'accept-language': 'nl' } })
    const body = await page.text()
    const csrf = decodeURIComponent(/hermie_oidc_csrf=([^;,]*)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '')
    const token = /name="token" value="([^"]*)"/.exec(body)?.[1] ?? ''

    expect(body).toContain('<html lang="nl">')

    const done = await fetch(`${web.url}/oidc/invite`, {
      method: 'POST',
      headers: {
        cookie: `hermie_oidc_csrf=${encodeURIComponent(csrf)}`,
        'content-type': 'application/x-www-form-urlencoded',
        'accept-language': 'nl'
      },
      body: new URLSearchParams({
        csrf,
        token,
        password: 'mary’s own long password',
        confirm: 'mary’s own long password'
      }).toString()
    })
    const confirmation = await done.text()

    expect(confirmation).toContain('<html lang="nl">')
    expect(confirmation).toContain('Je wachtwoord staat ingesteld')
    expect(confirmation).toContain('Terug naar Hermie Web')
    expect(confirmation).not.toContain('Inloggen mislukt')
  })

  it('refuses a duplicate username and a malformed one', async () => {
    const cookie = await signInToGateway(ADA)
    const duplicate = await post(cookie, '/admin/oidc/user', { do: 'create', username: 'katherine', role: 'user' })
    const nonsense = await post(cookie, '/admin/oidc/user', { do: 'create', username: 'a b/c', role: 'user' })

    expect(duplicate.notice).toContain('already has an account')
    expect(nonsense.notice).toContain('two to sixty-four')
  })

  it('never renders a password hash, a key or a secret', async () => {
    const { body } = await openIdentity(await signInToGateway(ADA))

    expect(body).not.toContain('PRIVATE KEY')
    expect(body).not.toContain('privatePem')
    expect(body).not.toContain('katherine’s own password')
    // The `sub` IS shown, deliberately: it is what the administrator list on
    // the main page is keyed by, so it has to be copyable.
    expect(body).toMatch(/<code class="note">[A-Za-z0-9_-]{22}<\/code>/)
  })

  it('disables, re-enables and re-roles somebody', async () => {
    const cookie = await signInToGateway(ADA)
    const sub = subOf('katherine')

    expect((await post(cookie, '/admin/oidc/user', { do: 'disable', sub })).notice).toContain('is disabled')
    expect(subRow('katherine')?.disabled).toBe(true)

    expect((await post(cookie, '/admin/oidc/user', { do: 'enable', sub })).notice).toContain('active again')
    expect(subRow('katherine')?.disabled).toBe(false)

    await post(cookie, '/admin/oidc/user', { do: 'role', sub, role: 'admin' })
    expect(subRow('katherine')?.role).toBe('admin')
  })

  it('removes somebody, with everything they held', async () => {
    const cookie = await signInToGateway(ADA)

    await post(cookie, '/admin/oidc/user', {
      do: 'create',
      username: 'temporary',
      email: '',
      displayName: '',
      role: 'user'
    })

    expect(subRow('temporary')).toBeTruthy()

    const result = await post(cookie, '/admin/oidc/user', { do: 'remove', sub: subOf('temporary') })

    expect(result.notice).toContain('gone')
    expect(subRow('temporary')).toBeUndefined()
  })
})

describe('the test sign-in', () => {
  it('runs the whole round trip and reports every step as ok', async () => {
    const cookie = await signInToGateway(ADA)
    const result = await post(cookie, '/admin/oidc/test', {
      username: 'katherine',
      password: 'katherine’s own password'
    })

    expect(result.notice).toContain('ran')

    for (const step of ['Discovery', 'Signing keys', 'Sign-in page', 'Sign-in', 'Token exchange', 'ID token']) {
      expect(result.page, `${step} should be reported`).toContain(step)
    }

    // No step failed. The page marks a failure with the `bad` class.
    expect(result.page.split('Test sign-in')[1]).not.toContain('>failed<')
    expect(result.page).toContain('The ID token verifies against the published key')
    // The refresh grant is the one push depends on.
    expect(result.page).toContain('rotated the refresh token')
    // And it never followed the redirect to the gateway.
    expect(result.page).toContain('The redirect was not followed')
  })

  it('reports a wrong password as a failed sign-in and goes no further', async () => {
    const result = await post(await signInToGateway(ADA), '/admin/oidc/test', {
      username: 'katherine',
      password: 'not the password'
    })

    expect(result.page).toContain('That account and password were not accepted')
    // The steps after it did not run, so the operator reads one red line.
    expect(result.page).not.toContain('Token exchange')
  })

  it('shows the result once and then clears it', async () => {
    const { body } = await openIdentity(await signInToGateway(ADA))

    expect(body).not.toContain('That account and password were not accepted')
  })

  it('does not put the password in the redirect it answers', async () => {
    const page = await openIdentity(await signInToGateway(ADA))
    const response = await fetch(`${web.url}/admin/oidc/test`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: page.csrf,
        username: 'katherine',
        password: 'katherine’s own password'
      }).toString()
    })

    expect(response.headers.get('location')).not.toContain('katherine%E2%80%99s')
    expect(response.headers.get('location')).not.toContain('password=')
  })
})

describe('the second factor, end to end through the pages', () => {
  it('enrols on the next sign-in once the setting requires one, and then works', async () => {
    const cookie = await signInToGateway(ADA)

    await post(cookie, '/admin/oidc/settings', { requireTotp: '1' })
    expect((await openIdentity(cookie)).body).toContain('checked')

    // A reader with a password but no second factor is sent to enrol.
    const authorize = `${web.url}/oidc/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: web.oidc.clientId,
      redirect_uri: `${new URL(gateway.url).origin}/auth/callback`,
      scope: 'openid profile email',
      state: 'test-state',
      code_challenge: 'X'.repeat(43),
      code_challenge_method: 'S256'
    }).toString()}`
    const form = await fetch(authorize)
    const formCsrf = decodeURIComponent(
      /hermie_oidc_csrf=([^;,]*)/.exec(form.headers.get('set-cookie') ?? '')?.[1] ?? ''
    )
    await form.text()

    const enrol = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `hermie_oidc_csrf=${encodeURIComponent(formCsrf)}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        csrf: formCsrf,
        username: 'katherine',
        password: 'katherine’s own password'
      }).toString()
    })
    const page = await enrol.text()

    expect(enrol.status).toBe(200)
    expect(page).toContain('Two-factor')
    expect(page).toContain('otpauth://totp/')
    // The recovery codes are shown here and nowhere else, ever.
    expect(page).toContain('Recovery codes')

    const secret = /<code>([A-Z2-7]{32})<\/code>/.exec(page)?.[1] ?? ''
    const session = /hermie_oidc_session=([^;,]*)/.exec(enrol.headers.get('set-cookie') ?? '')?.[1] ?? ''
    const enrolCsrf = decodeURIComponent(
      /hermie_oidc_csrf=([^;,]*)/.exec(enrol.headers.get('set-cookie') ?? '')?.[1] ?? ''
    )

    expect(secret).toBeTruthy()

    const confirmed = await fetch(`${web.url}/oidc/enrol`, {
      method: 'POST',
      headers: {
        cookie: `hermie_oidc_session=${session}; hermie_oidc_csrf=${encodeURIComponent(enrolCsrf)}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ csrf: enrolCsrf, totp: totpAt(secret) }).toString()
    })

    expect(confirmed.status).toBe(200)
    expect(await confirmed.text()).toContain('Two-factor is on')
    expect(subRow('katherine')?.totpSecret).toBe(secret)

    // And the admin page's test sign-in now needs the code as well.
    const withoutCode = await post(cookie, '/admin/oidc/test', {
      username: 'katherine',
      password: 'katherine’s own password'
    })

    expect(withoutCode.page).toContain('second factor enrolled, so the test needs a code')

    const withCode = await post(cookie, '/admin/oidc/test', {
      username: 'katherine',
      password: 'katherine’s own password',
      totp: totpAt(secret)
    })

    expect(withCode.page).toContain('The ID token verifies against the published key')
  })

  it('clears a second factor for somebody who lost their phone', async () => {
    const cookie = await signInToGateway(ADA)
    const result = await post(cookie, '/admin/oidc/user', { do: 'clear-totp', sub: subOf('katherine') })

    expect(result.notice).toContain('enrol a new one')
    expect(subRow('katherine')?.totpSecret).toBe('')
  })
})

describe('rotation and turning it off', () => {
  it('rotates the signing key and keeps the old one published', async () => {
    const before = ((await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: { kid: string }[] }).keys
    const result = await post(await signInToGateway(ADA), '/admin/oidc/rotate', {})
    const after = ((await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: { kid: string }[] }).keys

    expect(result.notice).toContain('new signing key')
    expect(after.length).toBe(before.length + 1)
    expect(after.map(key => key.kid)).toContain(before[0]?.kid)
  })

  it('turns off, keeps the accounts, and stops answering', async () => {
    const accounts = countAccounts()
    const result = await post(await signInToGateway(ADA), '/admin/oidc/enable', { enabled: '0' })

    expect(result.notice).toContain('Accounts and keys were kept')
    expect(web.oidc.enabled).toBe(false)
    expect(countAccounts()).toBe(accounts)
    expect((await fetch(`${web.url}/oidc/.well-known/openid-configuration`)).status).toBe(404)
  })

  it('turns back on with the same client id, so the gateway needs no change', async () => {
    const before = web.oidc.clientId

    await post(await signInToGateway(ADA), '/admin/oidc/enable', { enabled: '1' })

    expect(web.oidc.enabled).toBe(true)
    expect(web.oidc.clientId).toBe(before)
  })
})

/**
 * The issuer that is stored against the address the page was reached on.
 *
 * The deployment this was written for is a reverse proxy whose `$host` drops the
 * port: the provider was enabled once on `https://name:9443`, the header said
 * `https://name`, and every token since has named an origin nothing answers on.
 * Nothing in any log says "port" — the symptom is that sign-in stops working —
 * so the page has to be the thing that notices.
 *
 * `--allow-insecure-oidc` is not passed anywhere here. The forwarded origin is
 * `https`, which is what upstream's validator accepts, so the re-capture is
 * exercised through the same gate a real one goes through.
 */
describe('the issuer and the address it was reached on', () => {
  const FORWARDED = {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'hermie.example.invalid',
    'x-forwarded-port': '9443'
  }
  const MOVED = 'https://hermie.example.invalid:9443'

  /** `/admin/oidc` as a browser behind that proxy would reach it. */
  async function openAs(
    cookie: string,
    headers: Record<string, string>
  ): Promise<{ body: string; csrf: string; cookie: string }> {
    const response = await fetch(`${web.url}/admin/oidc`, { headers: { cookie, ...headers } })
    const body = await response.text()
    const csrf = decodeURIComponent(
      /hermie_admin_csrf=([^;,]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''
    )

    return { body, csrf, cookie: `${cookie}; hermie_admin_csrf=${csrf}` }
  }

  async function recaptureFrom(headers: Record<string, string>): Promise<string> {
    const page = await openAs(await signInToGateway(ADA), headers)
    const response = await fetch(`${web.url}/admin/oidc/recapture`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ csrf: page.csrf }).toString()
    })

    return new URL(response.headers.get('location') ?? '', web.url).searchParams.get('notice') ?? ''
  }

  it('prints the address it was reached on beside the stored issuer', async () => {
    const { body } = await openAs(await signInToGateway(ADA), {})

    expect(body).toContain('Reached on')
    expect(body).toContain(`<code>${web.url}/oidc</code>`)
    // Nothing to warn about while the two agree, and nothing to press either.
    expect(body).not.toContain('The stored issuer is not this address')
    expect(body).not.toContain('/admin/oidc/recapture')
  })

  it('says so when the forwarded origin is not the issuer, naming both', async () => {
    const { body } = await openAs(await signInToGateway(ADA), FORWARDED)

    expect(body).toContain('The stored issuer is not this address')
    expect(body).toContain(`<code>${web.url}/oidc</code>`)
    expect(body).toContain(`<code>${MOVED}</code>`)
    expect(body).toContain('/admin/oidc/recapture')
    expect(body).toContain('Re-capture the issuer from this address')
  })

  it('re-captures the issuer, keeping the client id, the keys and the accounts', async () => {
    const clientId = web.oidc.clientId
    const keys = ((await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: unknown[] }).keys.length
    const accounts = countAccounts()
    const notice = await recaptureFrom(FORWARDED)

    expect(notice).toContain(`${MOVED}/oidc`)
    expect(notice).toContain('Accounts, keys and sessions were kept')
    expect(web.oidc.issuer).toBe(`${MOVED}/oidc`)
    expect(web.oidc.clientId).toBe(clientId)
    expect(web.oidc.users.length).toBe(accounts)
    expect(web.oidc.enabled).toBe(true)

    /*
      The old key set is still published, unchanged.

      That is the difference from the off/on this replaces: disabling drops every
      refresh token, so correcting an address used to sign out every device in
      the deployment.
    */
    expect(((await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: unknown[] }).keys.length).toBe(keys)
  })

  it('and puts it back when the page is reached on the real address again', async () => {
    expect(await recaptureFrom({})).toContain(`${web.url}/oidc`)
    expect(web.oidc.issuer).toBe(`${web.url}/oidc`)
  })
})

/*
  The readers below go through the provider's own accessor rather than
  re-reading the file: the server holds the state in memory and the file lags a
  write by a tick, which is the race `admin.test.ts` already had to fix once.
*/
const subRow = (username: string) => web.oidc.users.find(user => user.username === username)

const subOf = (username: string): string => subRow(username)?.sub ?? ''

const countAccounts = (): number => web.oidc.users.length
