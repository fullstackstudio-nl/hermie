/**
 * "Test sign-in": the whole PKCE round trip, run from the server against its
 * own issuer, reporting each step.
 *
 * ## Why it goes over the network rather than through the objects
 *
 * It would be easier to call `OidcProvider` directly and assert on what comes
 * back. It would also be nearly worthless. Every interesting failure an
 * operator will actually hit lives *outside* those objects: a reverse proxy
 * that does not forward `/oidc`, a `Host` header the issuer does not match, TLS
 * that terminates somewhere unexpected, a firewall between the gateway and
 * this port. So this fetches `<issuer>/.well-known/openid-configuration` over
 * HTTP, exactly as the gateway will, and follows the document where it leads.
 *
 * **A "discovery unreachable" result is therefore a finding, not a defect.** If
 * this server cannot reach its own issuer URL, the gateway almost certainly
 * cannot either, and the operator has learnt that while they are still on the
 * page rather than at the first sign-in.
 *
 * ## Why it asks for a password
 *
 * Because there is no honest way to complete an authorization code flow
 * without one. A "test" that skipped the login form would be testing a code
 * path no reader ever takes, and a back door that minted a code without
 * credentials would be a back door. So the operator types a real account's
 * credentials, the flow runs as a browser would run it, and nothing is stored:
 * the credentials live in one function call and the tokens are discarded at the
 * end of it.
 *
 * ## What it never does
 *
 * Follow the redirect. The authorization response goes to the gateway's
 * callback, and actually requesting it would sign somebody in to the gateway as
 * a side effect of pressing a diagnostic button. The code is read out of the
 * `Location` header and redeemed here.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto'

export interface SelfTestStep {
  name: string
  ok: boolean
  /** One sentence for the operator. Never a token, a code or a password. */
  detail: string
}

export interface SelfTestInput {
  issuer: string
  clientId: string
  redirectUri: string
  username: string
  password: string
  totp?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

/** How long any one step may take before it is called unreachable. */
const STEP_TIMEOUT_MS = 10_000

const b64url = (bytes: Buffer): string => bytes.toString('base64url')

function csrfFrom(response: Response): { token: string; cookie: string } {
  const header = response.headers.get('set-cookie') ?? ''
  const token = decodeURIComponent(/hermie_oidc_csrf=([^;,]*)/.exec(header)?.[1] ?? '')

  return { token, cookie: token ? `hermie_oidc_csrf=${encodeURIComponent(token)}` : '' }
}

/**
 * Run it, and stop at the first step that fails.
 *
 * Stopping is deliberate: once discovery has failed, everything after it fails
 * for the same reason, and a page of eight red lines hides which one an
 * operator should read. The steps that never ran are simply absent.
 */
export async function runSelfTest(input: SelfTestInput): Promise<SelfTestStep[]> {
  const call = input.fetchImpl ?? fetch
  const steps: SelfTestStep[] = []
  const get = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail })

    return ok
  }

  const request = async (url: string, init?: RequestInit): Promise<Response> =>
    call(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(STEP_TIMEOUT_MS) })

  // 1. Discovery, with the two checks upstream makes on the document.
  let discovery: Record<string, string>

  try {
    const response = await request(`${input.issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' }
    })

    if (response.status !== 200) {
      get('Discovery', false, `${input.issuer}/.well-known/openid-configuration answered HTTP ${response.status}.`)

      return steps
    }

    discovery = (await response.json()) as Record<string, string>
  } catch (error) {
    get(
      'Discovery',
      false,
      `Could not reach ${input.issuer}/.well-known/openid-configuration from this server: ` +
        `${(error as Error).message}. The gateway reads the same URL, so it will not reach it either.`
    )

    return steps
  }

  if (discovery.issuer?.replace(/\/+$/, '') !== input.issuer.replace(/\/+$/, '')) {
    // Upstream refuses outright on this, so it is a failure rather than a note.
    get(
      'Discovery',
      false,
      `The document advertises issuer ${String(discovery.issuer)}, but this service's issuer is ${input.issuer}. ` +
        'The gateway refuses a document whose issuer does not match.'
    )

    return steps
  }

  const missing = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'].filter(field => !discovery[field])

  if (missing.length) {
    get('Discovery', false, `The document is missing ${missing.join(', ')}, which the gateway requires.`)

    return steps
  }

  get('Discovery', true, `${input.issuer} answered, and it advertises the endpoints the gateway requires.`)

  // 2. The JWKS.
  let jwks: { keys: { kid: string; kty: string; alg: string; n: string; e: string }[] }

  try {
    const response = await request(discovery.jwks_uri as string, { headers: { accept: 'application/json' } })
    jwks = (await response.json()) as typeof jwks

    if (!Array.isArray(jwks.keys) || !jwks.keys.length) {
      get('Signing keys', false, 'The JWKS is empty, so nothing could verify a token from this issuer.')

      return steps
    }
  } catch (error) {
    get('Signing keys', false, `Could not read ${String(discovery.jwks_uri)}: ${(error as Error).message}`)

    return steps
  }

  get(
    'Signing keys',
    true,
    jwks.keys.length === 1
      ? 'The JWKS publishes one key.'
      : `The JWKS publishes ${jwks.keys.length} keys — the current one and ${jwks.keys.length - 1} still being retired.`
  )

  // 3. The authorization request, built the way the gateway builds it.
  const verifier = b64url(randomBytes(64))
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  const state = b64url(randomBytes(32))
  const authorizeUrl = `${discovery.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: 'openid profile email offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString()}`
  let form: { token: string; cookie: string }

  try {
    const response = await request(authorizeUrl)

    if (response.status !== 200) {
      const body = await response.text()

      get(
        'Sign-in page',
        false,
        `The authorization endpoint answered HTTP ${response.status} instead of a sign-in form. ` +
          (body.includes('unauthorized_client')
            ? 'The client id it was given is not the one registered here.'
            : 'Check the redirect URI registered for the gateway.')
      )

      return steps
    }

    form = csrfFrom(response)
    await response.text()
  } catch (error) {
    get('Sign-in page', false, `Could not open the authorization endpoint: ${(error as Error).message}`)

    return steps
  }

  if (!form.token) {
    get('Sign-in page', false, 'The sign-in form came back without its form token.')

    return steps
  }

  get('Sign-in page', true, 'The authorization endpoint served a sign-in form.')

  // 4. The sign-in itself, and the second factor when one is enrolled.
  let code: string

  try {
    const fields = new URLSearchParams({ csrf: form.token, username: input.username, password: input.password })
    let response = await request(authorizeUrl, {
      method: 'POST',
      headers: { cookie: form.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString()
    })

    // A 200 here is the form again: either a refusal, or the second-factor step.
    if (response.status === 200) {
      const body = await response.text()

      if (!body.includes('Six-digit code')) {
        get('Sign-in', false, 'That account and password were not accepted.')

        return steps
      }

      if (!input.totp) {
        get('Sign-in', false, 'That account has a second factor enrolled, so the test needs a code from it too.')

        return steps
      }

      const second = csrfFrom(response)
      response = await request(authorizeUrl, {
        method: 'POST',
        headers: {
          cookie: second.cookie || form.cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          csrf: second.token || form.token,
          username: input.username,
          totp: input.totp
        }).toString()
      })

      if (response.status === 200) {
        await response.text()
        get('Sign-in', false, 'That one-time code was not accepted.')

        return steps
      }
    }

    const location = response.headers.get('location') ?? ''

    if (response.status !== 302 || !location) {
      get('Sign-in', false, `The sign-in answered HTTP ${response.status} rather than a redirect.`)

      return steps
    }

    const target = new URL(location)

    if (target.searchParams.get('error')) {
      get('Sign-in', false, `The authorization response was an error: ${target.searchParams.get('error')}`)

      return steps
    }

    if (target.searchParams.get('state') !== state) {
      get('Sign-in', false, 'The authorization response did not carry back the state it was given.')

      return steps
    }

    code = target.searchParams.get('code') ?? ''

    if (!code) {
      get('Sign-in', false, 'The authorization response carried no code.')

      return steps
    }
  } catch (error) {
    get('Sign-in', false, `The sign-in could not be completed: ${(error as Error).message}`)

    return steps
  }

  get(
    'Sign-in',
    true,
    // The redirect is READ, never followed: requesting it would sign somebody
    // in to the gateway as a side effect of a diagnostic.
    `The sign-in produced an authorization code for ${input.redirectUri}. The redirect was not followed.`
  )

  // 5. The code exchange, with the exact form the gateway posts.
  let tokens: Record<string, string>

  try {
    const response = await request(discovery.token_endpoint as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        code_verifier: verifier
      }).toString()
    })

    tokens = (await response.json()) as Record<string, string>

    if (response.status !== 200) {
      get('Token exchange', false, `The token endpoint answered ${String(tokens.error ?? response.status)}.`)

      return steps
    }
  } catch (error) {
    get('Token exchange', false, `The token endpoint could not be reached: ${(error as Error).message}`)

    return steps
  }

  if (!tokens.id_token) {
    // Upstream errors by name on exactly this.
    get('Token exchange', false, 'The token response carried no id_token, which the gateway requires.')

    return steps
  }

  get(
    'Token exchange',
    true,
    `The code was exchanged for an ID token${tokens.refresh_token ? ' and a refresh token' : ''}.`
  )

  // 6. Verify the ID token the way the relying party will.
  const claims = verifyAgainstJwks(tokens.id_token, jwks, { issuer: input.issuer, audience: input.clientId })

  if (typeof claims === 'string') {
    get('ID token', false, claims)

    return steps
  }

  get(
    'ID token',
    true,
    `The ID token verifies against the published key. The gateway will know this person as ${String(claims.sub)}.`
  )

  // 7. Userinfo, which upstream does not read but which OIDC requires.
  if (discovery.userinfo_endpoint) {
    try {
      const response = await request(discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' }
      })

      get(
        'User info',
        response.status === 200,
        response.status === 200
          ? 'The userinfo endpoint answered with this account’s claims.'
          : `The userinfo endpoint answered HTTP ${response.status}.`
      )
    } catch (error) {
      get('User info', false, `The userinfo endpoint could not be reached: ${(error as Error).message}`)
    }
  }

  // 8. The refresh grant, which is what push depends on.
  if (!tokens.refresh_token) {
    get(
      'Refresh',
      false,
      'No refresh token was issued, so the service login this deployment needs for push would not work. ' +
        'Add offline_access to the gateway’s configured scopes.'
    )

    return steps
  }

  try {
    const response = await request(discovery.token_endpoint as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: input.clientId,
        refresh_token: tokens.refresh_token,
        scope: 'openid profile email offline_access'
      }).toString()
    })
    const rotated = (await response.json()) as Record<string, string>

    if (response.status !== 200 || !rotated.id_token) {
      get('Refresh', false, `The refresh grant answered ${String(rotated.error ?? response.status)}.`)

      return steps
    }

    get(
      'Refresh',
      true,
      rotated.refresh_token && rotated.refresh_token !== tokens.refresh_token
        ? 'The refresh grant answered a fresh ID token and rotated the refresh token.'
        : 'The refresh grant answered a fresh ID token.'
    )
  } catch (error) {
    get('Refresh', false, `The refresh grant could not be completed: ${(error as Error).message}`)
  }

  return steps
}

/**
 * Verify a compact JWS against a fetched JWKS, or answer why not.
 *
 * Written out here rather than calling `verifyJwt` on purpose: this is the
 * step that is supposed to prove the PUBLISHED key verifies the token, and
 * reaching into the provider's own key objects to do it would quietly make
 * that untrue.
 */
export function verifyAgainstJwks(
  token: string,
  jwks: { keys: { kid: string; kty: string; alg: string; n: string; e: string }[] },
  pinned: { issuer: string; audience: string }
): Record<string, unknown> | string {
  const parts = token.split('.')

  if (parts.length !== 3) {
    return 'The ID token is not a compact JWS.'
  }

  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]
  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>

  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as { alg?: string; kid?: string }
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return 'The ID token could not be decoded.'
  }

  const jwk = jwks.keys.find(key => key.kid === header.kid)

  if (!jwk) {
    return `The ID token names kid ${String(header.kid)}, which the JWKS does not publish.`
  }

  let verified = false

  try {
    verified = cryptoVerify(
      'sha256',
      Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii'),
      createPublicKey({ key: { ...jwk }, format: 'jwk' }),
      Buffer.from(rawSignature, 'base64url')
    )
  } catch (error) {
    return `The published key could not be used: ${(error as Error).message}`
  }

  if (!verified) {
    return 'The published key does not verify the ID token’s signature.'
  }

  // The exact five upstream tells PyJWT to require, then the two it pins.
  for (const required of ['exp', 'iat', 'aud', 'iss', 'sub'] as const) {
    if (claims[required] === undefined) {
      return `The ID token has no ${required} claim, which the gateway requires.`
    }
  }

  if (claims.iss !== pinned.issuer) {
    return `The ID token says iss=${String(claims.iss)}, but the issuer is ${pinned.issuer}.`
  }

  if (claims.aud !== pinned.audience) {
    return `The ID token says aud=${String(claims.aud)}, but the client id is ${pinned.audience}.`
  }

  return claims
}
