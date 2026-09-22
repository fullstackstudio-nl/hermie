/**
 * The built-in provider, end to end over real HTTP against the real server.
 *
 * Every request here is the one upstream's relying party actually makes. The
 * authorize URL is built the way `pkce_login_start` builds it — same
 * parameters, same order of concerns, no `nonce`, `S256` — and the token POST
 * carries the exact form `JwtOAuthProvider.complete_login` sends. A test that
 * drove the provider through its own TypeScript interface would prove the
 * provider agrees with itself; this one proves it agrees with the thing that
 * has to accept it.
 *
 * The ID token is verified against the PUBLISHED JWKS, fetched over HTTP, with
 * `node:crypto` directly rather than through `verifyJwt`. That is deliberate:
 * using our own verifier would make a bug in it invisible, and the question
 * this file exists to answer is "would PyJWT accept this", not "do we like it".
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { createAccount, enableProvider, issuerOriginAcceptable, setAccountDisabled } from './accounts'
import { totpAt } from './totp'

/** The gateway's `dashboard.public_url`, which decides the one redirect URI. */
const GATEWAY_PUBLIC_URL = 'https://hermes.example.invalid'
const REDIRECT_URI = `${GATEWAY_PUBLIC_URL}/auth/callback`
const PASSWORD = 'a password long enough to be one'

let web: HermieWebServer
let stateDir: string
let clientId: string
let issuer: string
let adaSub: string

const b64url = (bytes: Buffer): string => bytes.toString('base64url')

/** A PKCE pair the way upstream's `pkce_login_start` makes one. */
function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(64))

  return {
    verifier,
    challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    state: b64url(randomBytes(32))
  }
}

/** The authorize URL, parameter for parameter as upstream builds it. */
function authorizeUrl(params: {
  challenge: string
  state: string
  scope?: string
  redirectUri?: string
  clientId?: string
  extra?: Record<string, string>
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId ?? clientId,
    redirect_uri: params.redirectUri ?? REDIRECT_URI,
    scope: params.scope ?? 'openid profile email offline_access',
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    ...(params.extra ?? {})
  })

  return `${web.url}/oidc/authorize?${query.toString()}`
}

function csrfOf(response: Response): { token: string; cookie: string } {
  const header = response.headers.get('set-cookie') ?? ''
  const token = decodeURIComponent(/hermie_oidc_csrf=([^;,]*)/.exec(header)?.[1] ?? '')

  return { token, cookie: `hermie_oidc_csrf=${token}` }
}

/**
 * Sign in through the form and come back with the redirect the browser gets.
 *
 * Two POSTs when a second factor is enrolled, exactly as the page drives it:
 * the first is refused with the code form, the second carries the code.
 */
async function signIn(options: {
  challenge: string
  state: string
  scope?: string
  username?: string
  password?: string
  totp?: string
  recovery?: string
  cookie?: string
}): Promise<Response> {
  const url = authorizeUrl({
    challenge: options.challenge,
    state: options.state,
    ...(options.scope ? { scope: options.scope } : {})
  })
  const page = await fetch(url, { headers: options.cookie ? { cookie: options.cookie } : {} })
  const { token, cookie } = csrfOf(page)

  await page.text()

  const fields = new URLSearchParams({
    csrf: token,
    username: options.username ?? 'ada',
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.totp ? { totp: options.totp } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {})
  })

  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: fields.toString()
  })
}

/** The code out of a 302's `Location`, and the `state` beside it. */
function codeOf(response: Response): { code: string; state: string; error: string } {
  const location = new URL(response.headers.get('location') ?? 'https://nowhere.invalid')

  return {
    code: location.searchParams.get('code') ?? '',
    state: location.searchParams.get('state') ?? '',
    error: location.searchParams.get('error') ?? ''
  }
}

/** `POST /oidc/token`, with the exact body upstream sends for each grant. */
async function postToken(fields: Record<string, string>): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${web.url}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString()
  })

  return { status: response.status, body: (await response.json()) as Record<string, string> }
}

const exchange = (code: string, verifier: string) =>
  postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier
  })

/**
 * Verify a token the way the relying party does: fetch the JWKS, pick the key
 * by `kid`, check the signature and the five required claims.
 */
async function verifyLikeUpstream(token: string): Promise<Record<string, unknown>> {
  const jwks = (await (await fetch(`${web.url}/oidc/jwks`)).json()) as {
    keys: { kid: string; n: string; e: string; kty: string; alg: string; use: string }[]
  }
  const [rawHeader, rawPayload, rawSignature] = token.split('.') as [string, string, string]
  const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as { kid: string; alg: string }

  expect(header.alg).toBe('RS256')

  const jwk = jwks.keys.find(key => key.kid === header.kid)

  expect(jwk, `the JWKS should publish kid ${header.kid}`).toBeTruthy()
  expect(
    cryptoVerify(
      'sha256',
      Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii'),
      createPublicKey({ key: { ...jwk! }, format: 'jwk' }),
      Buffer.from(rawSignature, 'base64url')
    ),
    'the published key should verify the signature'
  ).toBe(true)

  const claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as Record<string, unknown>

  // The set PyJWT is told to `require`, plus the two it pins.
  for (const required of ['exp', 'iat', 'aud', 'iss', 'sub']) {
    expect(claims[required], `the token should carry ${required}`).toBeDefined()
  }

  expect(claims.iss).toBe(issuer)
  expect(claims.aud).toBe(clientId)

  return claims
}

beforeAll(async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-oidc-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-oidc-state-'))

  web = await startHermieWeb({
    // No gateway is reached in this file: `/oidc` answers for itself.
    gatewayUrl: 'http://127.0.0.1:9119',
    port: 0,
    staticDir,
    stateDir,
    version: '9.9.9',
    selfUpdate: false,
    env: {}
  })

  /*
    Enabled through the same call the admin page makes, on the origin the
    server is actually listening on. `web.url` is a loopback address, which is
    what upstream's `_require_https_or_loopback` allows on plain http — so no
    insecure flag is needed here and none is passed.
  */
  await web.oidc.update(state =>
    enableProvider(state, { origin: web.url, gatewayPublicUrl: GATEWAY_PUBLIC_URL, allowInsecure: false })
  )
  await web.oidc.update(state => {
    const created = createAccount(state, {
      username: 'ada',
      email: 'ada@example.invalid',
      displayName: 'Ada Lovelace',
      role: 'admin',
      password: PASSWORD
    })
    adaSub = created.user.sub

    return created.state
  })

  clientId = web.oidc.clientId
  issuer = web.oidc.issuer
})

afterAll(async () => {
  await web.close()
})

describe('discovery', () => {
  it('is served at the issuer path and advertises the issuer it was asked for', async () => {
    const response = await fetch(`${web.url}/oidc/.well-known/openid-configuration`)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    // Upstream refuses a document whose `issuer` differs from the configured
    // one, and pins the origin the document was SERVED from against it too.
    expect(body.issuer).toBe(`${web.url}/oidc`)
    expect(new URL(String(body.issuer)).origin).toBe(new URL(web.url).origin)
  })

  it('carries the three endpoints upstream refuses the document without', async () => {
    const body = (await (await fetch(`${web.url}/oidc/.well-known/openid-configuration`)).json()) as Record<
      string,
      string
    >

    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      expect(body[field], `discovery must carry ${field}`).toBeTruthy()
      expect(body[field]?.startsWith(issuer)).toBe(true)
    }
  })

  it('offers only what this provider will actually do', async () => {
    const body = (await (await fetch(`${web.url}/oidc/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >

    expect(body.response_types_supported).toEqual(['code'])
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    // S256 only: `plain` protects against nothing an interceptor cannot do.
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    // RS256, first on upstream's allow-list.
    expect(body.id_token_signing_alg_values_supported).toEqual(['RS256'])
    // A public client: there is no secret in this design and it says so.
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(body.scopes_supported).toContain('offline_access')
  })

  it('publishes a JWKS with a key that names itself', async () => {
    const body = (await (await fetch(`${web.url}/oidc/jwks`)).json()) as {
      keys: { kid: string; kty: string; alg: string; use: string; n: string; e: string; d?: string }[]
    }

    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
    expect(body.keys[0]?.kid).toBeTruthy()
    // The half a browser is given, and only that half.
    expect(body.keys[0]?.d).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
  })
})

describe('the PKCE round trip', () => {
  it('signs somebody in and answers a token the published JWKS verifies', async () => {
    const { verifier, challenge, state } = pkce()
    const redirect = await signIn({ challenge, state, password: PASSWORD })
    const { code, state: echoed, error } = codeOf(redirect)

    expect(error).toBe('')
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')?.startsWith(REDIRECT_URI)).toBe(true)
    // The client's own CSRF value, handed back untouched.
    expect(echoed).toBe(state)
    expect(code).toBeTruthy()

    const { status, body } = await exchange(code, verifier)

    expect(status).toBe(200)
    // `token_type` has to be bearer or absent: upstream refuses anything else.
    expect(body.token_type).toBe('Bearer')
    expect(body.id_token).toBeTruthy()

    const claims = await verifyLikeUpstream(body.id_token as string)

    // `sub` becomes `Session.user_id` upstream, which is what /api/auth/me says.
    expect(claims.sub).toBe(adaSub)
    expect(claims.email).toBe('ada@example.invalid')
    expect(claims.name).toBe('Ada Lovelace')
    expect(claims.preferred_username).toBe('ada')
    expect(claims.groups).toEqual(['admin'])
  })

  it('answers a refresh token only when offline_access was asked for', async () => {
    const withScope = pkce()
    const granted = await exchange(codeOf(await signIn({ ...withScope, password: PASSWORD })).code, withScope.verifier)

    expect(granted.body.refresh_token).toBeTruthy()

    const without = pkce()
    const plain = await exchange(
      codeOf(await signIn({ ...without, password: PASSWORD, scope: 'openid profile' })).code,
      without.verifier
    )

    expect(plain.status).toBe(200)
    expect(plain.body.refresh_token).toBeUndefined()
  })

  it('refuses a code_verifier that does not match the challenge', async () => {
    const { challenge, state } = pkce()
    const { code } = codeOf(await signIn({ challenge, state, password: PASSWORD }))
    const { status, body } = await exchange(code, b64url(randomBytes(64)))

    expect(status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })

  it('spends a code on the first exchange, including a failing one', async () => {
    const { verifier, challenge, state } = pkce()
    const { code } = codeOf(await signIn({ challenge, state, password: PASSWORD }))

    expect((await exchange(code, verifier)).status).toBe(200)
    expect((await exchange(code, verifier)).status).toBe(400)

    const second = pkce()
    const spent = codeOf(await signIn({ ...second, password: PASSWORD })).code

    // A wrong verifier consumes it too, so it cannot be probed.
    await exchange(spent, b64url(randomBytes(64)))
    expect((await exchange(spent, second.verifier)).body.error).toBe('invalid_grant')
  })

  it('refuses a code redeemed against another redirect_uri', async () => {
    const { verifier, challenge, state } = pkce()
    const { code } = codeOf(await signIn({ challenge, state, password: PASSWORD }))
    const { status, body } = await postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://elsewhere.invalid/auth/callback',
      client_id: clientId,
      code_verifier: verifier
    })

    expect(status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })

  it('answers the same refusal for a wrong password as for an account that does not exist', async () => {
    /*
      One PKCE pair for both, so the only thing that could differ between the
      two pages is the account. Two pairs would put two different `state` and
      `code_challenge` values into the form's action and make the comparison
      about the test's own randomness instead.
    */
    const shared = pkce()
    const wrong = await signIn({ ...shared, password: 'not the password' })
    const missing = await signIn({ ...shared, username: 'nobody', password: PASSWORD })

    expect(wrong.status).toBe(200)
    expect(missing.status).toBe(200)

    /*
      Compared with the only two things that legitimately differ normalised
      away: the username the reader typed, which is echoed back into the field,
      and the per-render CSRF token. Everything else — the sentence, the status,
      the byte length — has to be identical, because a difference is an oracle
      for which accounts exist on this issuer.
    */
    const normalise = (page: string): string => page.replace(/value="[^"]*"/g, 'value="X"')

    const refusal = await wrong.text()

    expect(refusal).toContain('That sign-in was not right.')
    expect(normalise(await missing.text())).toBe(normalise(refusal))
  })
})

describe('the language the sign-in is painted in', () => {
  it('follows Accept-Language, and is English where there is none', async () => {
    const { challenge, state } = pkce()
    const url = authorizeUrl({ challenge, state })

    const dutch = await fetch(url, { headers: { 'accept-language': 'nl-BE,nl;q=0.9,en;q=0.4' } })
    const page = await dutch.text()

    expect(dutch.status).toBe(200)
    expect(page).toContain('<html lang="nl">')
    expect(page).toContain('<h1>Inloggen</h1>')
    expect(page).toContain('Gebruikersnaam')

    const plain = await (await fetch(url)).text()

    expect(plain).toContain('<html lang="en">')
    expect(plain).toContain('<h1>Sign in</h1>')
  })

  it('says the same nothing about the account in German as it does in English', async () => {
    const { challenge, state } = pkce()
    const url = authorizeUrl({ challenge, state })
    const page = await fetch(url, { headers: { 'accept-language': 'de' } })
    const { token, cookie } = csrfOf(page)

    await page.text()

    const refusal = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'de' },
      body: new URLSearchParams({ csrf: token, username: 'ada', password: 'not the password' }).toString()
    })
    const body = await refusal.text()

    expect(body).toContain('<html lang="de">')
    // The one generic sentence, translated. Nothing here says which half was
    // wrong, in this language any more than in English.
    expect(body).toContain('Diese Anmeldung war nicht richtig.')
    expect(body).not.toContain('Passwort war')
  })
})

describe('what must not be redirected', () => {
  it('renders an unknown client rather than bouncing the error anywhere', async () => {
    const { challenge, state } = pkce()
    const response = await fetch(authorizeUrl({ challenge, state, clientId: 'somebody-elses-client' }), {
      redirect: 'manual'
    })

    // RFC 6749 §4.1.2.1: an error may only go to a VERIFIED redirect_uri.
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('unauthorized_client')
  })

  it('renders an unregistered redirect_uri rather than redirecting to it', async () => {
    const { challenge, state } = pkce()
    const response = await fetch(
      authorizeUrl({ challenge, state, redirectUri: 'https://attacker.invalid/auth/callback' }),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('redirects the errors that DO belong to a verified client', async () => {
    const { challenge, state } = pkce()
    const response = await fetch(
      `${authorizeUrl({ challenge, state })}`.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(302)
    expect(codeOf(response).error).toBe('invalid_request')
    expect(codeOf(response).state).toBe(state)
  })

  it('refuses a POST that does not carry the page’s token', async () => {
    const { challenge, state } = pkce()
    const response = await fetch(authorizeUrl({ challenge, state }), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'ada', password: PASSWORD }).toString()
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('location')).toBeNull()
  })
})

describe('refresh rotation', () => {
  async function freshRefreshToken(): Promise<string> {
    const { verifier, challenge, state } = pkce()
    const { body } = await exchange(codeOf(await signIn({ challenge, state, password: PASSWORD })).code, verifier)

    return body.refresh_token as string
  }

  const refresh = (token: string) =>
    postToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: token,
      // Upstream re-requests its configured scopes on every refresh.
      scope: 'openid profile email offline_access'
    })

  it('answers a new id_token and a new refresh token, and retires the old one', async () => {
    const first = await freshRefreshToken()
    const rotated = await refresh(first)

    expect(rotated.status).toBe(200)
    // `_grant` reads `token_key="id_token"` on the refresh path too.
    expect(rotated.body.id_token).toBeTruthy()
    await verifyLikeUpstream(rotated.body.id_token as string)

    expect(rotated.body.refresh_token).toBeTruthy()
    expect(rotated.body.refresh_token).not.toBe(first)

    // The successor works.
    expect((await refresh(rotated.body.refresh_token as string)).status).toBe(200)
  })

  it('revokes the whole family when a rotated token is replayed', async () => {
    const first = await freshRefreshToken()
    const second = (await refresh(first)).body.refresh_token as string
    const third = (await refresh(second)).body.refresh_token as string

    // The stolen copy comes back. Everything from that sign-in goes.
    const replay = await refresh(second)

    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')
    expect(replay.body.error_description).toMatch(/revoked/)

    // Including the one the legitimate holder had.
    expect((await refresh(third)).status).toBe(400)
  })

  it('refuses a refresh token this issuer never minted', async () => {
    expect((await refresh(b64url(randomBytes(32)))).body.error).toBe('invalid_grant')
  })

  it('refuses one belonging to another client', async () => {
    const token = await freshRefreshToken()
    const { status, body } = await postToken({
      grant_type: 'refresh_token',
      client_id: 'another-client',
      refresh_token: token
    })

    expect(status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })

  it('stops working the moment the account is disabled', async () => {
    const created = await web.oidc.update(
      state =>
        createAccount(state, {
          username: 'grace',
          email: 'grace@example.invalid',
          displayName: 'Grace Hopper',
          role: 'user',
          password: PASSWORD
        }).state
    )
    const grace = created.users.find(user => user.username === 'grace')

    expect(grace, 'the account should have been created').toBeTruthy()

    const { verifier, challenge, state } = pkce()
    const { body } = await exchange(
      codeOf(await signIn({ challenge, state, username: 'grace', password: PASSWORD })).code,
      verifier
    )

    expect(body.refresh_token).toBeTruthy()

    await web.oidc.update(current => setAccountDisabled(current, grace?.sub ?? '', true))

    expect((await refresh(body.refresh_token as string)).status).toBe(400)
    // And they cannot sign in again either.
    expect(codeOf(await signIn({ ...pkce(), username: 'grace', password: PASSWORD })).code).toBe('')
  })
})

describe('the access token and userinfo', () => {
  it('answers the claims the granted scopes entitle a caller to', async () => {
    const { verifier, challenge, state } = pkce()
    const { body } = await exchange(codeOf(await signIn({ challenge, state, password: PASSWORD })).code, verifier)
    const response = await fetch(`${web.url}/oidc/userinfo`, {
      headers: { authorization: `Bearer ${body.access_token}` }
    })
    const claims = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(claims.sub).toBe(adaSub)
    expect(claims.email).toBe('ada@example.invalid')
  })

  it('refuses a missing, a forged and an ID token in the bearer slot', async () => {
    const anonymous = await fetch(`${web.url}/oidc/userinfo`)

    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer')

    expect((await fetch(`${web.url}/oidc/userinfo`, { headers: { authorization: 'Bearer nonsense' } })).status).toBe(
      401
    )

    const { verifier, challenge, state } = pkce()
    const { body } = await exchange(codeOf(await signIn({ challenge, state, password: PASSWORD })).code, verifier)
    // An ID token is `typ: JWT`; the access token is `typ: at+jwt`. Swapping one
    // for the other is refused rather than quietly accepted.
    const swapped = await fetch(`${web.url}/oidc/userinfo`, {
      headers: { authorization: `Bearer ${body.id_token}` }
    })

    expect(swapped.status).toBe(401)
  })
})

describe('the second factor', () => {
  let totpSecret = ''

  beforeAll(async () => {
    const created = await web.oidc.update(
      state =>
        createAccount(state, {
          username: 'katherine',
          email: 'katherine@example.invalid',
          displayName: 'Katherine Johnson',
          role: 'user',
          password: PASSWORD
        }).state
    )
    const sub = created.users.find(user => user.username === 'katherine')?.sub ?? ''

    // An enrolment that has already been confirmed, which is the state the
    // `/oidc/enrol` page leaves an account in.
    await web.oidc.update(state => ({
      ...state,
      users: state.users.map(user =>
        user.sub === sub
          ? {
              ...user,
              totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
              recoveryCodes: [createHash('sha256').update('RECOVERYCODE0001', 'utf8').digest('base64url')]
            }
          : user
      )
    }))

    totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  })

  it('asks for a code after the password and not before it', async () => {
    const { challenge, state } = pkce()
    const first = await signIn({ challenge, state, username: 'katherine', password: PASSWORD })
    const page = await first.text()

    expect(first.status).toBe(200)
    expect(page).toContain('Six-digit code')
    // The password field is gone, so nothing echoes it back into the page.
    expect(page).not.toContain('autocomplete="current-password"')
    expect(page).not.toContain(PASSWORD)
  })

  it('completes the round trip once the code is right', async () => {
    const { verifier, challenge, state } = pkce()
    const redirect = await signIn({
      challenge,
      state,
      username: 'katherine',
      totp: totpAt(totpSecret)
    })
    const { code } = codeOf(redirect)

    expect(redirect.status).toBe(302)
    expect(code).toBeTruthy()

    const { status, body } = await exchange(code, verifier)

    expect(status).toBe(200)
    expect((await verifyLikeUpstream(body.id_token as string)).preferred_username).toBe('katherine')
  })

  it('refuses a wrong code and a code for a step too far away', async () => {
    const wrong = await signIn({ ...pkce(), username: 'katherine', totp: '000000' })
    const stale = await signIn({
      ...pkce(),
      username: 'katherine',
      totp: totpAt(totpSecret, Math.floor(Date.now() / 1000) - 300)
    })

    expect(wrong.status).toBe(200)
    expect(await wrong.text()).toContain('That sign-in was not right.')
    expect(stale.status).toBe(200)
  })

  it('takes a recovery code once, and never again', async () => {
    const first = await signIn({ ...pkce(), username: 'katherine', recovery: 'RECOVERYCODE0001' })

    expect(first.status).toBe(302)
    expect(codeOf(first).code).toBeTruthy()

    const again = await signIn({ ...pkce(), username: 'katherine', recovery: 'RECOVERYCODE0001' })

    expect(again.status).toBe(200)
    expect(await again.text()).toContain('That sign-in was not right.')
  })
})

describe('a rotated key', () => {
  it('still verifies the tokens the previous key signed', async () => {
    const { verifier, challenge, state } = pkce()
    const before = await exchange(codeOf(await signIn({ challenge, state, password: PASSWORD })).code, verifier)
    const oldToken = before.body.id_token as string

    // Verified once against the JWKS as it is now.
    await verifyLikeUpstream(oldToken)

    const fresh = await web.oidc.rotateKeys()
    const jwks = (await (await fetch(`${web.url}/oidc/jwks`)).json()) as { keys: { kid: string }[] }

    // Both keys are published: a relying party holding a token from a minute
    // ago has to be able to find the key that signed it.
    expect(jwks.keys.length).toBeGreaterThanOrEqual(2)
    expect(jwks.keys[0]?.kid).toBe(fresh.kid)

    // The whole point: the OLD token still verifies against the NEW JWKS.
    expect((await verifyLikeUpstream(oldToken)).sub).toBe(adaSub)

    // And a token minted now is signed by the new key.
    const after = pkce()
    const later = await exchange(codeOf(await signIn({ ...after, password: PASSWORD })).code, after.verifier)
    const header = JSON.parse(
      Buffer.from((later.body.id_token as string).split('.')[0] as string, 'base64url').toString('utf8')
    ) as { kid: string }

    expect(header.kid).toBe(fresh.kid)
    await verifyLikeUpstream(later.body.id_token as string)
  })
})

describe('off by default', () => {
  it('answers 404 on every path when nothing has enabled it', async () => {
    const otherStatic = await mkdtemp(path.join(tmpdir(), 'hermie-web-oidc-off-static-'))
    await writeFile(path.join(otherStatic, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

    const off = await startHermieWeb({
      gatewayUrl: 'http://127.0.0.1:9119',
      port: 0,
      staticDir: otherStatic,
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-oidc-off-state-')),
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })

    try {
      expect(off.oidc.enabled).toBe(false)

      for (const route of ['/.well-known/openid-configuration', '/jwks', '/authorize', '/token', '/userinfo']) {
        expect((await fetch(`${off.url}/oidc${route}`)).status, `${route} should not exist`).toBe(404)
      }
    } finally {
      await off.close()
    }
  })

  it('refuses to enable on an origin the gateway would reject', () => {
    // Upstream's `_require_https_or_loopback`, mirrored: https anywhere, http
    // only on the three loopback names it lists.
    expect(issuerOriginAcceptable('https://hermes.example.com')).toBe(true)
    expect(issuerOriginAcceptable('http://127.0.0.1:9120')).toBe(true)
    expect(issuerOriginAcceptable('http://localhost:9120')).toBe(true)
    expect(issuerOriginAcceptable('http://[::1]:9120')).toBe(true)
    expect(issuerOriginAcceptable('http://hermes.example.com:9120')).toBe(false)
    expect(issuerOriginAcceptable('http://10.0.0.5:9120')).toBe(false)
    expect(issuerOriginAcceptable('not an address')).toBe(false)
  })

  it('keeps the state file 0600 and holds no working credential in it', async () => {
    const { stat, readFile } = await import('node:fs/promises')
    const file = path.join(stateDir, 'oidc.json')
    const { mode } = await stat(file)
    const body = await readFile(file, 'utf8')

    expect(mode & 0o777).toBe(0o600)
    // The signing key is here and has to be; a password and a live refresh
    // token are not.
    expect(body).toContain('PRIVATE KEY')
    expect(body).not.toContain(PASSWORD)
    expect(body).not.toContain('RECOVERYCODE0001')
  })
})

/**
 * What the provider's own pages look like, which is the deployment they belong
 * to.
 *
 * Somebody following an invitation link has never seen this service before and
 * has no way to tell a real one from a page that fetched them. Unstyled HTML
 * reads like a broken page and teaches people to ignore how a sign-in looks, so
 * the mark and the operator's own name are on every page here — and they are
 * asserted, because a style sheet that quietly stops being included is invisible
 * to every other test in this file.
 */
describe('the provider’s pages wear the deployment’s chrome', () => {
  it('puts the mark and the branding name on the sign-in page, with no script', async () => {
    const page = await fetch(authorizeUrl(pkce()))
    const body = await page.text()

    expect(page.status).toBe(200)
    expect(body).toContain('<svg class="mark"')
    expect(body).toContain('<span class="brand-name">Hermie</span>')
    expect(body).toContain('<title>Sign in to Hermie</title>')
    // Light and dark, from the reader's own setting; there is nothing to click.
    expect(body).toContain('prefers-color-scheme: dark')
    expect(body).not.toContain('<script')
    // And no search engine has any business here.
    expect(body).toContain('name="robots"')
  })

  it('puts it on the refusals too, which is where a reader is most at sea', async () => {
    const page = await fetch(authorizeUrl({ ...pkce(), clientId: 'somebody-else' }))
    const body = await page.text()

    expect(page.status).toBe(400)
    expect(body).toContain('<svg class="mark"')
    expect(body).toContain('<h1>Sign-in failed</h1>')
  })

  it('names the deployment once in the tab, not twice', async () => {
    const page = await fetch(authorizeUrl(pkce()))

    expect(await page.text()).not.toContain('Sign in to Hermie — Hermie')
  })
})
