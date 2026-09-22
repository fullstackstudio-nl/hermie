/**
 * The OpenID Provider: authorization code + PKCE, and nothing else.
 *
 * ## What it is for
 *
 * An operator who self-hosts a gateway and has no identity provider has, until
 * now, had two answers: run the gateway ungated, or stand up Keycloak. This is
 * the third — a provider inside the service that is already there. It is **off
 * by default**, it federates with nothing, and ADR-0025's amendment argues both
 * of those at length.
 *
 * ## Written against upstream's actual validator, not against the spec
 *
 * The relying party is `plugins/dashboard_auth/self_hosted/__init__.py`, and
 * every choice below is shaped by what it does rather than by what an OIDC
 * provider could do:
 *
 *  - **It verifies the ID token and treats the access token as opaque.** So the
 *    ID token is the thing that has to be right. It is signed RS256 and carries
 *    `iss`, `sub`, `aud`, `exp`, `iat` — the exact set PyJWT is told to
 *    `require` — with `aud` the client id and `iss` the discovered issuer.
 *  - **It never sends `nonce`** (`pkce_login_start` builds the authorize URL
 *    without one), so `nonce` is echoed when offered and never demanded.
 *  - **It re-verifies the ID token on every request** (`verify_session` reads
 *    `Session.access_token`, which holds the ID token), so the ID token's
 *    lifetime IS the gateway's session length. An hour, by default.
 *  - **Refresh must answer a new `id_token`.** `_grant` reads `token_key="id_token"`
 *    on both grants and errors by name when it is missing.
 *  - **It re-requests the same scopes on refresh** and tolerates a provider
 *    that does not rotate. This one does rotate, which is strictly better and
 *    which `refresh_token_from` handles.
 *
 * ## The redirect URI, and why the native loopback is not registered here
 *
 * ADR-0004 is easy to misread as "the app is a client of the identity
 * provider". It is not. `hermes_cli/dashboard_auth/native_flow.py` says so
 * outright — the gateway is "authorization server *to the desktop*, OAuth
 * client *to the Portal*" — and brokers the whole thing: the phone's loopback
 * redirect is registered with the GATEWAY, and the identity provider only ever
 * sees the gateway's own callback. Upstream's `validate_redirect_uri` insists
 * on it, refusing any redirect URI whose path does not end `/auth/callback`.
 *
 * So the one registered redirect URI is `<gateway public_url>/auth/callback`.
 * An operator can add more on `/admin`, and a loopback entry is matched by the
 * RFC 8252 rule (any port) for the deployment that genuinely has a direct
 * client — but nothing here pretends the phone is one.
 *
 * ## Codes, and what "short-lived" means
 *
 * A code is spent by a browser that is already mid-redirect, so sixty seconds
 * is generous rather than tight. It is single-use, bound to its PKCE challenge,
 * its redirect URI and its client, and consumed on EVERY path out of
 * `exchangeCode` — including the failing ones, so a code cannot be probed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { signJwt, tokenDigest, verifyJwt, type JwtClaims } from './jwt'
import { jwksDocument, rotatedKeys, signingKey, SIGNING_ALG, type PublicJwk, type StoredKey } from './keys'
import { type OidcState, type StoredRefresh } from './state'
import { findUserBySub, type OidcUser } from './users'

/** Scopes this provider understands. Anything else is dropped rather than refused. */
export const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

/** How long an authorization code lives. See the note above. */
export const CODE_TTL_SECONDS = 60

/** How long a browser's sign-in is remembered, so a second authorize does not re-prompt. */
export const LOGIN_SESSION_TTL_SECONDS = 12 * 3600

/**
 * The attempt ceiling on the login form, per username and per source address.
 *
 * Ten in fifteen minutes stops an online guessing run dead while leaving room
 * for somebody who genuinely cannot remember which of their passwords it is.
 * It is a deterrent on the ONLINE path only; the wall against an offline attack
 * on a stolen state file is scrypt, in `users.ts`.
 */
export const LOGIN_ATTEMPT_LIMIT = 10
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60

export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  responseType: string
  scope: string
  state: string
  codeChallenge: string
  codeChallengeMethod: string
  nonce: string
  prompt: string
}

/** A refusal that may be shown to the browser rather than redirected. */
export class AuthorizeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AuthorizeError'
  }
}

/** A refusal that belongs in a token endpoint's JSON error envelope. */
export class TokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'TokenError'
  }
}

interface PendingCode {
  sub: string
  clientId: string
  redirectUri: string
  scope: string
  nonce: string
  codeChallenge: string
  authTime: number
  expiresAt: number
}

interface LoginSession {
  sub: string
  authTime: number
  expiresAt: number
}

export interface IssuedTokens {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  id_token: string
  scope: string
  refresh_token?: string
}

export interface OidcProviderOptions {
  /** The state as the server holds it. One authority, as `AdminRouter` has. */
  read: () => OidcState
  /** Persist a changed state and tell the server about it. */
  write: (state: OidcState) => Promise<void>
  now?: () => number
  random?: (size: number) => Buffer
}

const b64url = (bytes: Buffer): string => bytes.toString('base64url')

/** S256, as RFC 7636 §4.6 defines it. The only method this provider accepts. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/**
 * Does this redirect URI match a registered one?
 *
 * Exact string match, with one documented exception: RFC 8252 §7.3 says a
 * native client's loopback redirect may use any port, because the client cannot
 * know which port it will get. So a REGISTERED loopback entry matches any port
 * on the same host and path. Everything else is compared whole, because a
 * prefix or host-suffix match is how open redirects are built.
 */
export function redirectUriMatches(registered: readonly string[], offered: string): boolean {
  if (registered.includes(offered)) {
    return true
  }

  let candidate: URL

  try {
    candidate = new URL(offered)
  } catch {
    return false
  }

  const loopback = candidate.hostname === '127.0.0.1' || candidate.hostname === '[::1]' || candidate.hostname === '::1'

  if (!loopback || candidate.protocol !== 'http:') {
    return false
  }

  return registered.some(entry => {
    try {
      const url = new URL(entry)

      return url.protocol === 'http:' && url.hostname === candidate.hostname && url.pathname === candidate.pathname
    } catch {
      return false
    }
  })
}

export class OidcProvider {
  /** Codes, in memory: see the file note on why these do not survive a restart. */
  private readonly codes = new Map<string, PendingCode>()
  private readonly logins = new Map<string, LoginSession>()
  private readonly attempts = new Map<string, number[]>()

  constructor(private readonly options: OidcProviderOptions) {}

  private get now(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1000)
  }

  private get state(): OidcState {
    return this.options.read()
  }

  private random(size: number): Buffer {
    return (this.options.random ?? randomBytes)(size)
  }

  /**
   * Change the state through the one write path this process has.
   *
   * The admin routes and the tests both go through here rather than touching
   * the file, so there is exactly one authority — the variable in
   * `startHermieWeb` — the same arrangement `AdminRouter` has.
   */
  async update(change: (state: OidcState) => OidcState): Promise<OidcState> {
    const next = change(this.state)

    await this.options.write(next)

    return next
  }

  get enabled(): boolean {
    return this.state.enabled
  }

  get issuer(): string {
    return this.state.issuer
  }

  /** The one registered client's id, fixed per install. */
  get clientId(): string {
    return this.state.client.clientId
  }

  /**
   * The discovery document, at `<issuer>/.well-known/openid-configuration`.
   *
   * Three fields are load-bearing rather than decorative, because upstream
   * refuses the document without them: `authorization_endpoint`,
   * `token_endpoint` and `jwks_uri`. A fourth is load-bearing in a subtler way
   * — `issuer` must equal the configured issuer modulo a trailing slash, and
   * the URL that SERVED the document has to share its origin, which is why the
   * issuer is stored rather than rebuilt from a `Host` header.
   *
   * `token_endpoint_auth_methods_supported: ["none"]` is this provider saying
   * out loud that it is a public client. Upstream only consults that list when
   * a `client_secret` is configured, and there is none to configure here.
   */
  discovery(): Record<string, unknown> {
    const issuer = this.issuer

    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [SIGNING_ALG],
      scopes_supported: [...SUPPORTED_SCOPES],
      token_endpoint_auth_methods_supported: ['none'],
      // S256 only. `plain` is not offered and not accepted: a challenge equal
      // to its verifier protects against nothing an interceptor cannot do.
      code_challenge_methods_supported: ['S256'],
      claims_supported: [
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'email',
        'email_verified',
        'name',
        'preferred_username',
        'groups'
      ]
    }
  }

  jwks(): { keys: PublicJwk[] } {
    return jwksDocument(this.state.keys)
  }

  /**
   * Check an authorization request before anything is shown to the reader.
   *
   * The order is the one RFC 6749 §4.1.2.1 requires and it matters: a bad
   * `client_id` or `redirect_uri` must be shown to the READER, because
   * redirecting an error to an unverified URI is how an open redirect is built.
   * Everything after those two is redirected back to the client as an `error`.
   */
  checkAuthorize(request: AuthorizeRequest): void {
    const { client } = this.state

    if (!this.enabled) {
      throw new AuthorizeError('temporarily_unavailable', 'This issuer is not enabled.')
    }

    if (!request.clientId || request.clientId !== client.clientId) {
      throw new AuthorizeError('unauthorized_client', 'That client id is not registered with this issuer.')
    }

    if (!request.redirectUri || !redirectUriMatches(client.redirectUris, request.redirectUri)) {
      throw new AuthorizeError('invalid_request', 'That redirect_uri is not registered with this issuer.')
    }
  }

  /**
   * The rest of the checks — the ones whose failure may be redirected.
   *
   * PKCE is mandatory and `S256` is the only method. RFC 7636 allows `plain`;
   * this provider does not, because an authorization code intercepted on a
   * loopback redirect is the threat PKCE exists for and `plain` does not stop
   * it. Upstream always sends `S256`, so nothing is lost.
   */
  checkAuthorizeParams(request: AuthorizeRequest): void {
    if (request.responseType !== 'code') {
      throw new AuthorizeError('unsupported_response_type', 'This issuer only supports the authorization code flow.')
    }

    if (request.codeChallengeMethod !== 'S256') {
      throw new AuthorizeError('invalid_request', 'code_challenge_method must be S256.')
    }

    // 43 characters is the shortest a base64url SHA-256 digest can be.
    if (!request.codeChallenge || request.codeChallenge.length < 43) {
      throw new AuthorizeError('invalid_request', 'A PKCE code_challenge is required.')
    }

    if (!this.grantedScopes(request.scope).includes('openid')) {
      throw new AuthorizeError('invalid_scope', 'The openid scope is required.')
    }
  }

  /** Requested scopes narrowed to the ones this provider issues, in a stable order. */
  grantedScopes(requested: string): string[] {
    const asked = new Set(requested.split(/\s+/).filter(Boolean))

    return SUPPORTED_SCOPES.filter(scope => asked.has(scope))
  }

  /** Mint a code for a reader who has just proved who they are. */
  issueCode(user: OidcUser, request: AuthorizeRequest, authTime: number): string {
    const code = b64url(this.random(32))

    this.sweepCodes()
    this.codes.set(code, {
      sub: user.sub,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: this.grantedScopes(request.scope).join(' '),
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
      authTime,
      expiresAt: this.now + CODE_TTL_SECONDS
    })

    return code
  }

  /**
   * Redeem a code for tokens.
   *
   * The code is deleted before anything else is checked, so every path out of
   * here — success, a wrong verifier, a mismatched redirect — consumes it. A
   * code that survived a failed exchange could be retried against a guessed
   * verifier, which is the whole of what PKCE is defending.
   */
  async exchangeCode(params: {
    code: string
    codeVerifier: string
    redirectUri: string
    clientId: string
  }): Promise<IssuedTokens> {
    const pending = this.codes.get(params.code)
    this.codes.delete(params.code)

    if (!pending || pending.expiresAt <= this.now) {
      throw new TokenError('invalid_grant', 'That authorization code has expired or was already used.')
    }

    if (pending.clientId !== params.clientId) {
      throw new TokenError('invalid_grant', 'That code was issued to another client.')
    }

    if (pending.redirectUri !== params.redirectUri) {
      throw new TokenError('invalid_grant', 'That code was issued for another redirect_uri.')
    }

    if (!params.codeVerifier || !constantTimeEquals(s256(params.codeVerifier), pending.codeChallenge)) {
      throw new TokenError('invalid_grant', 'The PKCE code_verifier does not match the challenge.')
    }

    const user = findUserBySub(this.state.users, pending.sub)

    if (!user || user.disabled) {
      throw new TokenError('invalid_grant', 'That account no longer exists or has been disabled.')
    }

    return this.issueTokens(user, {
      scope: pending.scope,
      nonce: pending.nonce,
      authTime: pending.authTime,
      family: b64url(this.random(16))
    })
  }

  /**
   * Rotate a refresh token.
   *
   * Three outcomes, and the third is the one worth reading. A token that is
   * unknown or lapsed is simply refused. A token that is valid is spent and
   * replaced. A token that has ALREADY been spent is a replay — the legitimate
   * holder has the successor, so whoever is presenting this one has a stolen
   * copy — and the answer is to revoke the entire family, signing out both.
   * That is OAuth 2.0 Security BCP §4.14.2, and it is why `family` exists.
   */
  async refresh(params: { refreshToken: string; clientId: string; scope: string }): Promise<IssuedTokens> {
    const digest = tokenDigest(params.refreshToken)
    const state = this.state
    const held = state.refresh.find(row => row.digest === digest)

    if (!held || held.expiresAt <= this.now) {
      throw new TokenError('invalid_grant', 'That refresh token is not one this issuer will honour.')
    }

    if (held.clientId !== params.clientId) {
      throw new TokenError('invalid_grant', 'That refresh token was issued to another client.')
    }

    if (held.used) {
      await this.revokeFamily(held.family)

      throw new TokenError(
        'invalid_grant',
        'That refresh token had already been rotated; every token from that sign-in has been revoked.'
      )
    }

    const user = findUserBySub(state.users, held.sub)

    if (!user || user.disabled) {
      await this.revokeFamily(held.family)

      throw new TokenError('invalid_grant', 'That account no longer exists or has been disabled.')
    }

    // Upstream re-requests its configured scopes on refresh. A request may
    // narrow what it was granted and may never widen it.
    const asked = params.scope ? this.grantedScopes(params.scope) : held.scope.split(' ').filter(Boolean)
    const granted = asked.filter(scope => held.scope.split(' ').includes(scope))

    return this.issueTokens(user, {
      scope: granted.join(' '),
      nonce: '',
      authTime: held.issuedAt,
      family: held.family,
      supersedes: digest
    })
  }

  /**
   * Sign one ID token, one access token and — when `offline_access` was granted
   * — one refresh token.
   *
   * `offline_access` gates the refresh token deliberately rather than issuing
   * one always. Hermie Web's own service login REQUIRES one (`push/login.ts`
   * refuses a grant without it in so many words), and the guide on `/admin`
   * says to put the scope in the gateway's configuration for exactly that
   * reason. A provider that handed one out unasked would make that instruction
   * look optional until the day somebody tightened it.
   */
  private async issueTokens(
    user: OidcUser,
    grant: { scope: string; nonce: string; authTime: number; family: string; supersedes?: string }
  ): Promise<IssuedTokens> {
    const state = this.state
    const key = signingKey(state.keys)

    if (!key) {
      throw new TokenError('temporarily_unavailable', 'This issuer has no signing key.', 500)
    }

    const now = this.now
    const scopes = grant.scope.split(' ').filter(Boolean)
    const idToken = signJwt(
      {
        ...this.identityClaims(user, scopes),
        iss: state.issuer,
        sub: user.sub,
        aud: state.client.clientId,
        iat: now,
        exp: now + state.settings.idTokenTtlSeconds,
        auth_time: grant.authTime,
        ...(grant.nonce ? { nonce: grant.nonce } : {})
      },
      key
    )
    const accessToken = signJwt(
      {
        iss: state.issuer,
        sub: user.sub,
        aud: state.client.clientId,
        iat: now,
        exp: now + state.settings.accessTokenTtlSeconds,
        scope: grant.scope,
        jti: b64url(this.random(12))
      },
      key,
      'at+jwt'
    )

    const tokens: IssuedTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: state.settings.accessTokenTtlSeconds,
      id_token: idToken,
      scope: grant.scope
    }

    if (!scopes.includes('offline_access')) {
      if (grant.supersedes) {
        await this.markUsed(grant.supersedes, [])
      }

      return tokens
    }

    const refreshToken = b64url(this.random(32))
    const row: StoredRefresh = {
      digest: tokenDigest(refreshToken),
      family: grant.family,
      sub: user.sub,
      clientId: state.client.clientId,
      scope: grant.scope,
      issuedAt: now,
      expiresAt: now + state.settings.refreshTokenTtlSeconds,
      used: false
    }

    await this.markUsed(grant.supersedes ?? '', [row])

    return { ...tokens, refresh_token: refreshToken }
  }

  /** Mark one digest spent and append whatever replaced it, in one write. */
  private async markUsed(supersedes: string, added: StoredRefresh[]): Promise<void> {
    const state = this.state
    const now = this.now

    await this.options.write({
      ...state,
      refresh: [
        ...state.refresh
          .filter(row => row.expiresAt > now)
          .map(row => (row.digest === supersedes ? { ...row, used: true } : row)),
        ...added
      ]
    })
  }

  /** Drop every token from one sign-in. Used on a replay and on a sign-out. */
  async revokeFamily(family: string): Promise<void> {
    const state = this.state

    await this.options.write({ ...state, refresh: state.refresh.filter(row => row.family !== family) })
  }

  /** Drop every token belonging to one person, e.g. when they are disabled. */
  async revokeUser(sub: string): Promise<void> {
    const state = this.state

    await this.options.write({ ...state, refresh: state.refresh.filter(row => row.sub !== sub) })
  }

  /** The identity claims a granted scope entitles the client to. */
  identityClaims(user: OidcUser, scopes: readonly string[]): Record<string, unknown> {
    return {
      ...(scopes.includes('email') && user.email ? { email: user.email, email_verified: false } : {}),
      ...(scopes.includes('profile')
        ? {
            name: user.displayName || user.username,
            preferred_username: user.username,
            // Upstream folds `groups` into `org_id` when no `org_id` claim is
            // present, which is the only place a role reaches the gateway.
            groups: [user.role]
          }
        : {})
    }
  }

  /** `/oidc/userinfo`: the claims behind a live access token. */
  userinfo(accessToken: string): Record<string, unknown> {
    const state = this.state
    let claims: JwtClaims

    try {
      claims = verifyJwt(accessToken, state.keys, {
        issuer: state.issuer,
        audience: state.client.clientId,
        now: this.now,
        typ: 'at+jwt'
      })
    } catch (error) {
      throw new TokenError('invalid_token', (error as Error).message, 401)
    }

    const user = findUserBySub(state.users, claims.sub)

    if (!user || user.disabled) {
      throw new TokenError('invalid_token', 'That account no longer exists or has been disabled.', 401)
    }

    const scopes = String(claims.scope ?? '')
      .split(' ')
      .filter(Boolean)

    return { sub: user.sub, ...this.identityClaims(user, scopes) }
  }

  // ---- The login form's own session and its rate limit ----

  /** Remember that this browser signed in, so a second authorize does not re-prompt. */
  createLoginSession(user: OidcUser): string {
    const value = b64url(this.random(24))
    const now = this.now

    this.sweepLogins()
    this.logins.set(value, { sub: user.sub, authTime: now, expiresAt: now + LOGIN_SESSION_TTL_SECONDS })

    return value
  }

  loginSession(value: string): { user: OidcUser; authTime: number } | null {
    const held = value ? this.logins.get(value) : undefined

    if (!held || held.expiresAt <= this.now) {
      return null
    }

    const user = findUserBySub(this.state.users, held.sub)

    return user && !user.disabled ? { user, authTime: held.authTime } : null
  }

  endLoginSession(value: string): void {
    this.logins.delete(value)
  }

  /** Forget every browser session belonging to one person. */
  endSessionsFor(sub: string): void {
    for (const [value, held] of this.logins) {
      if (held.sub === sub) {
        this.logins.delete(value)
      }
    }
  }

  /**
   * Has this name, from this address, run out of attempts?
   *
   * Keyed on both so that one person guessing at `admin` cannot lock the real
   * administrator out from their own desk, and so that a distributed run
   * against one name is still counted.
   */
  rateLimited(key: string): boolean {
    const now = this.now
    const recent = (this.attempts.get(key) ?? []).filter(at => at > now - LOGIN_ATTEMPT_WINDOW_SECONDS)

    if (recent.length) {
      this.attempts.set(key, recent)
    } else {
      this.attempts.delete(key)
    }

    return recent.length >= LOGIN_ATTEMPT_LIMIT
  }

  noteFailedAttempt(key: string): void {
    const now = this.now
    const recent = (this.attempts.get(key) ?? []).filter(at => at > now - LOGIN_ATTEMPT_WINDOW_SECONDS)

    this.attempts.set(key, [...recent, now])
  }

  clearAttempts(key: string): void {
    this.attempts.delete(key)
  }

  // ---- Key rotation ----

  /**
   * Rotate the signing key, keeping the old one readable in the JWKS.
   *
   * The hold is the longest-lived thing the old key signed — the ID token or
   * the access token, whichever is longer — plus upstream's own JWKS cache
   * window (`PyJWKClient(lifespan=300)`), because a relying party holding a
   * five-minute-old copy of the JWKS has not seen the new key yet and would
   * otherwise reject a token signed with it.
   */
  async rotateKeys(): Promise<StoredKey> {
    const state = this.state
    const hold =
      Math.max(state.settings.idTokenTtlSeconds, state.settings.accessTokenTtlSeconds) + JWKS_CACHE_ALLOWANCE_SECONDS
    const keys = rotatedKeys(state.keys, { now: this.now, holdSeconds: hold })

    await this.options.write({ ...state, keys })

    return keys[0] as StoredKey
  }

  private sweepCodes(): void {
    const now = this.now

    for (const [code, pending] of this.codes) {
      if (pending.expiresAt <= now) {
        this.codes.delete(code)
      }
    }
  }

  private sweepLogins(): void {
    const now = this.now

    for (const [value, held] of this.logins) {
      if (held.expiresAt <= now) {
        this.logins.delete(value)
      }
    }
  }
}

/**
 * Upstream's `PyJWKClient` caches the JWKS for `JWKS_CACHE_SECONDS = 300`.
 * A rotation has to stay readable for at least that long after it happens, or a
 * relying party with a warm cache rejects the first tokens signed by the new
 * key.
 */
export const JWKS_CACHE_ALLOWANCE_SECONDS = 300

/** Compare two base64url digests without leaking where they first differ. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')

  return a.length === b.length && timingSafeEqual(a, b)
}
