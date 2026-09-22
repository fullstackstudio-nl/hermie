/**
 * `/oidc/*` — the provider's HTTP surface, as one handler the server hands a
 * request to.
 *
 * The routes, and which of them a relying party actually reads:
 *
 * | Path                                     | Who calls it                          |
 * | ---------------------------------------- | ------------------------------------- |
 * | `/.well-known/openid-configuration`      | the gateway, once an hour             |
 * | `/jwks`                                  | the gateway, cached five minutes      |
 * | `/authorize`                             | the reader's browser                  |
 * | `/token`                                 | the gateway, server to server         |
 * | `/userinfo`                              | nobody upstream; kept because OIDC     |
 * | `/logout`                                | the reader's browser                  |
 * | `/invite`, `/enrol`                      | the reader's browser                  |
 *
 * ## Two cookies, two `SameSite` values, and why
 *
 * The sign-in session is `Lax`: a reader reaches `/authorize` by a top-level
 * navigation from the gateway, which is cross-site, and a `Strict` cookie is
 * not sent on one — every visit would re-prompt. The CSRF token is `Strict`,
 * because the form that carries it is served and posted by this origin, and
 * `Strict` is what makes the double submit worth anything.
 *
 * ## What is never logged
 *
 * A password, a TOTP code, a recovery code, an authorization code, an access,
 * ID or refresh token, or the value of either cookie. This file writes no log
 * line containing a request body or a query string at all, which is the only
 * version of that rule that survives somebody adding a route later.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { CSRF_FIELD, cookieOf, newToken, setCookie, tokensMatch } from '../admin/session'
import { webCopy, webStrings, type WebStrings } from '../i18n'
import { isSecureRequest } from '../proxy'
import { enrolPage, invitePage, oidcDonePage, oidcErrorPage, signInPage, signedOutPage } from './page'
import {
  LOGIN_SESSION_TTL_SECONDS,
  type AuthorizeError,
  type AuthorizeRequest,
  type OidcProvider,
  type TokenError
} from './provider'
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, totpMatches } from './totp'
import { findUser, hashPassword, passwordMatches, recoveryDigest, spendRecoveryCode, type OidcUser } from './users'
import { tokenDigest } from './jwt'
import type { OidcState } from './state'

/** The cookie one signed-in browser rides in. */
export const OIDC_SESSION_COOKIE = 'hermie_oidc_session'

/**
 * This router's own CSRF cookie, deliberately NOT the admin page's.
 *
 * Both are minted per render, so sharing one name would mean an operator with
 * `/admin` open in one tab and a sign-in in another silently invalidating
 * whichever form they submitted second. Not a hole — a refusal, which is the
 * safe direction — but a confusing one, and two names cost nothing.
 */
export const OIDC_CSRF_COOKIE = 'hermie_oidc_csrf'

/** At most 16 KiB of form body. A sign-in form is a few hundred bytes. */
const MAX_FORM_BYTES = 16 * 1024

/** The prefix every path here sits under. The issuer's path, by construction. */
export const OIDC_PREFIX = '/oidc'

export interface OidcRouterOptions {
  provider: OidcProvider
  /** The state as the server holds it. One authority, as `AdminRouter` has. */
  read: () => OidcState
  write: (state: OidcState) => Promise<void>
  /** What the sign-in page calls this deployment. The branding name, else "Hermie Web". */
  issuerName: () => string
  /**
   * Where "back to the application" goes: a path on this origin.
   *
   * The root, because that is where this service serves the app. Named rather
   * than written into the page so the one place that knows the answer is the
   * server that does the serving.
   */
  appPath: string
  now?: () => number
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length

    if (size > MAX_FORM_BYTES) {
      throw new Error('the request body is too large')
    }

    chunks.push(buffer)
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The address this request came from, for the attempt counter.
 *
 * `X-Forwarded-For`'s first entry when a reverse proxy set one — the same
 * header `proxy.ts` already forwards — else the socket. It is a rate-limit key
 * and nothing else: a forged header can only make somebody share a bucket with
 * a stranger, never bypass one, because the username is half of the key.
 */
function clientAddress(request: IncomingMessage): string {
  const raw = request.headers['x-forwarded-for']
  const first = Array.isArray(raw) ? raw[0] : raw
  const forwarded = (first ?? '').split(',')[0]?.trim()

  return forwarded || request.socket.remoteAddress || 'unknown'
}

/** An in-flight two-factor enrolment, held until the reader proves it works. */
interface PendingEnrolment {
  sub: string
  secret: string
  recoveryCodes: string[]
  expiresAt: number
}

export class OidcRouter {
  /**
   * Enrolments that have been shown but not confirmed.
   *
   * In memory, keyed by the sign-in session. A restart mid-enrolment means a
   * fresh secret next time, which is correct: a secret the reader may not have
   * finished saving is one nobody should be committed to.
   */
  private readonly enrolments = new Map<string, PendingEnrolment>()

  constructor(private readonly options: OidcRouterOptions) {}

  /** Every path this router owns. Checked before the proxy sees the request. */
  owns(pathname: string): boolean {
    return pathname === OIDC_PREFIX || pathname.startsWith(`${OIDC_PREFIX}/`)
  }

  private get now(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1000)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase()
    const route = url.pathname.slice(OIDC_PREFIX.length) || '/'

    /*
      A provider that is off does not exist.

      404 rather than 503, for the same reason `/setup` answers 404 once it is
      closed: a path that says "forbidden" or "not yet" invites somebody to come
      back and look, and there is nothing here to find on a deployment that
      never turned this on.
    */
    if (!this.options.provider.enabled) {
      this.json(response, 404, { error: 'not_found' })

      return
    }

    switch (route) {
      case '/.well-known/openid-configuration':
        this.json(response, 200, this.options.provider.discovery())

        return

      case '/jwks':
        this.json(response, 200, this.options.provider.jwks())

        return

      case '/authorize':
        await this.authorize(request, response, url, method)

        return

      case '/token':
        await this.token(request, response, method)

        return

      case '/userinfo':
        this.userinfo(request, response, method)

        return

      case '/logout':
        this.logout(request, response, url)

        return

      case '/invite':
        await this.invite(request, response, url, method)

        return

      case '/enrol':
        await this.enrol(request, response, url, method)

        return

      default:
        this.json(response, 404, { error: 'not_found' })
    }
  }

  // ---- /authorize ----

  private authorizeRequestOf(url: URL): AuthorizeRequest {
    const get = (name: string): string => url.searchParams.get(name) ?? ''

    return {
      clientId: get('client_id'),
      redirectUri: get('redirect_uri'),
      responseType: get('response_type'),
      scope: get('scope'),
      state: get('state'),
      codeChallenge: get('code_challenge'),
      codeChallengeMethod: get('code_challenge_method'),
      nonce: get('nonce'),
      prompt: get('prompt')
    }
  }

  private async authorize(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<void> {
    if (method !== 'GET' && method !== 'POST') {
      this.json(response, 405, { error: 'method_not_allowed' })

      return
    }

    const ask = this.authorizeRequestOf(url)

    /*
      The client and the redirect URI are checked FIRST and their failure is
      rendered rather than redirected.

      RFC 6749 §4.1.2.1: an error may only be sent to a redirect_uri that has
      been verified to belong to the client. Redirecting the error to whatever
      was asked for is precisely how an authorization endpoint becomes an open
      redirect.
    */
    try {
      this.options.provider.checkAuthorize(ask)
    } catch (error) {
      const failure = error as AuthorizeError

      this.failure(request, response, 400, failure.code, failure.message)

      return
    }

    // From here a failure belongs to the client, so it goes back to the
    // redirect URI that has just been verified.
    try {
      this.options.provider.checkAuthorizeParams(ask)
    } catch (error) {
      const failure = error as AuthorizeError

      this.redirectToClient(response, ask, { error: failure.code, error_description: failure.message })

      return
    }

    const sessionValue = cookieOf(request.headers.cookie, OIDC_SESSION_COOKIE)
    const held = this.options.provider.loginSession(sessionValue)

    if (method === 'GET') {
      // `prompt=login` is honoured because a relying party that asks to
      // re-authenticate has a reason to, even though upstream never sends it.
      if (held && ask.prompt !== 'login') {
        this.finishAuthorize(response, ask, held.user, held.authTime, sessionValue, isSecureRequest(request))

        return
      }

      this.renderSignIn(request, response, url, { username: '', wantsSecondFactor: false, notice: '' })

      return
    }

    await this.signIn(request, response, url, ask)
  }

  /**
   * The sign-in form's POST: password, then — when one is enrolled — a code.
   *
   * The refusal is the same sentence for every failure. An unknown username, a
   * wrong password, a disabled account and a wrong second factor are one answer
   * here, because four answers is an oracle for which accounts exist.
   */
  private async signIn(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    ask: AuthorizeRequest
  ): Promise<void> {
    let form: URLSearchParams

    try {
      form = await this.checkedForm(request)
    } catch (error) {
      this.failure(request, response, 403, 'invalid_request', (error as Error).message)

      return
    }

    const username = (form.get('username') ?? '').trim()
    const bucket = `${username.toLowerCase()} ${clientAddress(request)}`

    if (this.options.provider.rateLimited(bucket)) {
      this.renderSignIn(request, response, url, {
        username,
        wantsSecondFactor: false,
        notice: 'tooManyAttempts'
      })

      return
    }

    const state = this.options.read()
    const user = findUser(state.users, username)
    const password = form.get('password') ?? ''
    const totp = form.get('totp') ?? ''
    const recovery = form.get('recovery') ?? ''
    const secondStep = Boolean(totp || recovery)

    /*
      The first step still runs `passwordMatches` against a hash that cannot
      match when the account does not exist.

      Returning early on an unknown username would make this endpoint answer
      "does this person have an account" in the time it takes to reply: a real
      account costs an scrypt run and a missing one would cost nothing.
    */
    if (!secondStep) {
      const ok = passwordMatches(user?.password, password) && !!user && !user.disabled

      if (!ok) {
        this.options.provider.noteFailedAttempt(bucket)
        this.renderSignIn(request, response, url, {
          username,
          wantsSecondFactor: false,
          notice: 'notRight'
        })

        return
      }

      if (user.totpSecret) {
        this.renderSignIn(request, response, url, { username, wantsSecondFactor: true, notice: '' })

        return
      }

      if (state.settings.requireTotp) {
        this.beginEnrolment(request, response, user)

        return
      }

      await this.accept(response, ask, user, bucket, isSecureRequest(request))

      return
    }

    /*
      The second step re-reads the password field, which the form does not
      carry.

      It cannot: echoing a password through a hidden field would put it in the
      page, in the history and in any proxy log that records a body. So the
      second step trusts that the first one passed for this username in this
      browser — which is why the attempt counter is checked again here and why a
      code alone, with no prior password, cannot reach `accept`: a user with no
      TOTP secret enrolled fails the `totpMatches` below, and one with a secret
      only got here after a correct password.
    */
    if (!user || user.disabled || !user.totpSecret) {
      this.options.provider.noteFailedAttempt(bucket)
      this.renderSignIn(request, response, url, {
        username,
        wantsSecondFactor: true,
        notice: 'notRight'
      })

      return
    }

    if (totp && totpMatches(user.totpSecret, totp, { now: this.now })) {
      await this.accept(response, ask, user, bucket, isSecureRequest(request))

      return
    }

    if (recovery) {
      const remaining = spendRecoveryCode(user, recovery)

      if (remaining) {
        // Spent before the session is minted, so a code cannot be used twice by
        // a reader who replays the form while the first request is in flight.
        await this.updateUser(user.sub, held => ({ ...held, recoveryCodes: remaining }))
        await this.accept(response, ask, user, bucket, isSecureRequest(request))

        return
      }
    }

    this.options.provider.noteFailedAttempt(bucket)
    this.renderSignIn(request, response, url, {
      username,
      wantsSecondFactor: true,
      notice: 'notRight'
    })
  }

  /** A sign-in that succeeded: clear the counter, mint the session, redirect. */
  private async accept(
    response: ServerResponse,
    ask: AuthorizeRequest,
    user: OidcUser,
    bucket: string,
    secure: boolean
  ): Promise<void> {
    const now = this.now

    this.options.provider.clearAttempts(bucket)
    await this.updateUser(user.sub, held => ({ ...held, lastSignInAt: now }))

    this.finishAuthorize(response, ask, user, now, this.options.provider.createLoginSession(user), secure)
  }

  /** Mint the code and send the browser back to the client. */
  private finishAuthorize(
    response: ServerResponse,
    ask: AuthorizeRequest,
    user: OidcUser,
    authTime: number,
    session: string,
    secure: boolean
  ): void {
    const code = this.options.provider.issueCode(user, ask, authTime)

    this.redirectToClient(
      response,
      ask,
      { code },
      session
        ? [
            setCookie(OIDC_SESSION_COOKIE, session, {
              secure,
              httpOnly: true,
              sameSite: 'Lax',
              maxAge: LOGIN_SESSION_TTL_SECONDS
            })
          ]
        : []
    )
  }

  private redirectToClient(
    response: ServerResponse,
    ask: AuthorizeRequest,
    params: Record<string, string>,
    cookies: string[] = []
  ): void {
    const target = new URL(ask.redirectUri)

    for (const [name, value] of Object.entries(params)) {
      target.searchParams.set(name, value)
    }

    // `state` is echoed on success and on failure alike: it is the client's own
    // CSRF value and a failure it cannot correlate is one it has to ignore.
    if (ask.state) {
      target.searchParams.set('state', ask.state)
    }

    response.writeHead(302, {
      location: target.toString(),
      'cache-control': 'no-store',
      ...(cookies.length ? { 'set-cookie': cookies } : {})
    })
    response.end()
  }

  /**
   * The sign-in form.
   *
   * `notice` is named rather than written out, because every caller wants the
   * same two sentences and both of them have to come from the language this
   * request asked for — which is not known until this method has read the
   * header.
   */
  private renderSignIn(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    input: {
      username: string
      wantsSecondFactor: boolean
      notice: '' | 'notRight' | 'tooManyAttempts'
    }
  ): void {
    const copy = webCopy(request)

    this.html(
      response,
      200,
      signInPage({
        issuerName: this.options.issuerName(),
        csrf: this.mintCsrf(response, isSecureRequest(request)),
        query: url.searchParams.toString(),
        ...input,
        notice: input.notice ? copy.strings.oidc.signIn[input.notice] : '',
        ...copy
      })
    )
  }

  // ---- /token ----

  private async token(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    if (method !== 'POST') {
      this.json(response, 405, { error: 'invalid_request', error_description: 'The token endpoint takes a POST.' })

      return
    }

    let form: URLSearchParams

    try {
      form = await readForm(request)
    } catch (error) {
      this.json(response, 400, { error: 'invalid_request', error_description: (error as Error).message })

      return
    }

    const grantType = form.get('grant_type') ?? ''

    try {
      if (grantType === 'authorization_code') {
        this.json(
          response,
          200,
          await this.options.provider.exchangeCode({
            code: form.get('code') ?? '',
            codeVerifier: form.get('code_verifier') ?? '',
            redirectUri: form.get('redirect_uri') ?? '',
            clientId: form.get('client_id') ?? ''
          })
        )

        return
      }

      if (grantType === 'refresh_token') {
        this.json(
          response,
          200,
          await this.options.provider.refresh({
            refreshToken: form.get('refresh_token') ?? '',
            clientId: form.get('client_id') ?? '',
            scope: form.get('scope') ?? ''
          })
        )

        return
      }

      this.json(response, 400, {
        error: 'unsupported_grant_type',
        error_description: 'This issuer supports authorization_code and refresh_token.'
      })
    } catch (error) {
      const failure = error as TokenError

      // The shape upstream's `exchange_token` reads: a 400 with an `error`
      // field is how it tells "this code is spent" from "the IdP is down".
      this.json(response, failure.status ?? 400, {
        error: failure.code ?? 'invalid_request',
        error_description: failure.message
      })
    }
  }

  // ---- /userinfo ----

  private userinfo(request: IncomingMessage, response: ServerResponse, method: string): void {
    if (method !== 'GET' && method !== 'POST') {
      this.json(response, 405, { error: 'method_not_allowed' })

      return
    }

    const header = String(request.headers.authorization ?? '')
    const bearer = /^Bearer (.+)$/i.exec(header)?.[1] ?? ''

    if (!bearer) {
      response.writeHead(401, {
        'www-authenticate': 'Bearer realm="hermie-web"',
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(JSON.stringify({ error: 'invalid_token' }))

      return
    }

    try {
      this.json(response, 200, this.options.provider.userinfo(bearer))
    } catch (error) {
      const failure = error as TokenError

      this.json(response, failure.status ?? 401, { error: failure.code ?? 'invalid_token' })
    }
  }

  // ---- /logout ----

  /**
   * End the browser's sign-in here.
   *
   * It does NOT end the gateway's session, and the page says so: this provider
   * has no back-channel to the relying party and inventing one would be a
   * second protocol to get wrong. `post_logout_redirect_uri` is honoured only
   * when it is registered, for the same open-redirect reason `/authorize` has.
   */
  private logout(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const session = cookieOf(request.headers.cookie, OIDC_SESSION_COOKIE)

    if (session) {
      this.options.provider.endLoginSession(session)
      this.enrolments.delete(session)
    }

    const cleared = setCookie(OIDC_SESSION_COOKIE, '', {
      secure: isSecureRequest(request),
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 0
    })
    const wanted = url.searchParams.get('post_logout_redirect_uri') ?? ''
    const allowed = this.options.read().client.postLogoutRedirectUris

    if (wanted && allowed.includes(wanted)) {
      response.writeHead(302, { location: wanted, 'cache-control': 'no-store', 'set-cookie': cleared })
      response.end()

      return
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': cleared
    })
    response.end(signedOutPage({ issuerName: this.options.issuerName(), ...webCopy(request) }))
  }

  // ---- /invite ----

  /**
   * The one-time link that lets somebody choose their own first password.
   *
   * The token is compared as a DIGEST, so the state file never holds a working
   * link, and it is spent by the same write that stores the password — there is
   * no window in which both the link and the password work.
   */
  private async invite(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<void> {
    const token = method === 'GET' ? (url.searchParams.get('token') ?? '') : ''

    if (method === 'GET') {
      const user = this.userForInvite(token)

      if (!user) {
        this.failure(request, response, 400, 'invalid_token', strings => strings.oidc.error.inviteSpent)

        return
      }

      this.html(
        response,
        200,
        invitePage({
          issuerName: this.options.issuerName(),
          csrf: this.mintCsrf(response, isSecureRequest(request)),
          token,
          username: user.username,
          notice: '',
          ...webCopy(request)
        })
      )

      return
    }

    if (method !== 'POST') {
      this.json(response, 405, { error: 'method_not_allowed' })

      return
    }

    let form: URLSearchParams

    try {
      form = await this.checkedForm(request)
    } catch (error) {
      this.failure(request, response, 403, 'invalid_request', (error as Error).message)

      return
    }

    const offered = form.get('token') ?? ''
    const user = this.userForInvite(offered)
    const password = form.get('password') ?? ''
    const again = form.get('confirm') ?? ''

    const copy = webCopy(request)

    if (!user) {
      this.failure(request, response, 400, 'invalid_token', strings => strings.oidc.error.inviteSpent)

      return
    }

    const complaint = passwordComplaint(password, again, copy.strings)

    if (complaint) {
      this.html(
        response,
        400,
        invitePage({
          issuerName: this.options.issuerName(),
          csrf: this.mintCsrf(response, isSecureRequest(request)),
          token: offered,
          username: user.username,
          notice: complaint,
          ...copy
        })
      )

      return
    }

    await this.updateUser(user.sub, held => {
      const { invite: _spent, ...rest } = held

      return { ...rest, password: hashPassword(password) }
    })

    this.done(request, response, strings => ({
      title: strings.oidc.done.passwordSetTitle,
      detail: strings.oidc.done.passwordSetDetail
    }))
  }

  private userForInvite(token: string): OidcUser | null {
    if (!token) {
      return null
    }

    const digest = tokenDigest(token)
    const now = this.now

    return (
      this.options
        .read()
        .users.find(user => user.invite && user.invite.digest === digest && user.invite.expiresAt > now) ?? null
    )
  }

  // ---- /enrol ----

  /** Show a secret once, and only after a password has been accepted. */
  private beginEnrolment(request: IncomingMessage, response: ServerResponse, user: OidcUser): void {
    const session = this.options.provider.createLoginSession(user)
    const secret = newTotpSecret()
    const codes = newRecoveryCodes()

    this.enrolments.set(session, { sub: user.sub, secret, recoveryCodes: codes, expiresAt: this.now + 900 })

    const body = enrolPage({
      issuerName: this.options.issuerName(),
      csrf: this.mintCsrf(response, isSecureRequest(request)),
      username: user.username,
      secret,
      uri: otpauthUri({ issuerName: this.options.issuerName(), account: user.username, secret }),
      recoveryCodes: codes,
      notice: '',
      ...webCopy(request)
    })

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'set-cookie': [
        ...((response.getHeader('set-cookie') as string[] | undefined) ?? []),
        setCookie(OIDC_SESSION_COOKIE, session, {
          secure: isSecureRequest(request),
          httpOnly: true,
          sameSite: 'Lax',
          maxAge: LOGIN_SESSION_TTL_SECONDS
        })
      ]
    })
    response.end(body)
  }

  /** Confirm the enrolment by proving the authenticator works. */
  private async enrol(request: IncomingMessage, response: ServerResponse, _url: URL, method: string): Promise<void> {
    if (method !== 'POST') {
      this.json(response, 405, { error: 'method_not_allowed' })

      return
    }

    let form: URLSearchParams

    try {
      form = await this.checkedForm(request)
    } catch (error) {
      this.failure(request, response, 403, 'invalid_request', (error as Error).message)

      return
    }

    const session = cookieOf(request.headers.cookie, OIDC_SESSION_COOKIE)
    const pending = session ? this.enrolments.get(session) : undefined

    if (!pending || pending.expiresAt <= this.now) {
      this.failure(request, response, 400, 'invalid_request', strings => strings.oidc.error.enrolmentGone)

      return
    }

    if (!totpMatches(pending.secret, form.get('totp') ?? '', { now: this.now })) {
      this.failure(request, response, 400, 'invalid_request', strings => strings.oidc.error.codeNotRight)

      return
    }

    await this.updateUser(pending.sub, held => ({
      ...held,
      totpSecret: pending.secret,
      recoveryCodes: pending.recoveryCodes.map(code => recoveryDigest(normalizeRecoveryCode(code)))
    }))
    this.enrolments.delete(session)

    this.done(request, response, strings => ({
      title: strings.oidc.done.twoFactorTitle,
      detail: strings.oidc.done.twoFactorDetail
    }))
  }

  // ---- shared ----

  /** Change one person, through the single write path the server owns. */
  private async updateUser(sub: string, change: (user: OidcUser) => OidcUser): Promise<void> {
    const state = this.options.read()

    await this.options.write({
      ...state,
      users: state.users.map(user => (user.sub === sub ? change(user) : user))
    })
  }

  /** The body, but only once the double-submit token has matched. */
  private async checkedForm(request: IncomingMessage): Promise<URLSearchParams> {
    const cookie = cookieOf(request.headers.cookie, OIDC_CSRF_COOKIE)
    const form = await readForm(request)

    if (!tokensMatch(cookie, form.get(CSRF_FIELD) ?? '')) {
      throw new Error('that form did not carry this page’s token')
    }

    return form
  }

  /** One mint per render, so a token never outlives the page that carries it. */
  private mintCsrf(response: ServerResponse, secure: boolean): string {
    const value = newToken()
    const existing = (response.getHeader('set-cookie') as string[] | undefined) ?? []

    response.setHeader('set-cookie', [...existing, setCookie(OIDC_CSRF_COOKIE, value, { secure, httpOnly: false })])

    return value
  }

  private html(response: ServerResponse, status: number, body: string): void {
    const existing = response.getHeader('set-cookie')

    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      ...(existing ? { 'set-cookie': existing as string | string[] } : {})
    })
    response.end(body)
  }

  /**
   * The page at the end of something that worked, in this request's language.
   *
   * A 200 and a heading of its own, where both of these used to be a 200 on the
   * page headed "Sign-in failed". The status was never the problem — a browser
   * does not draw it — the heading was.
   */
  private done(
    request: IncomingMessage,
    response: ServerResponse,
    copyFor: (strings: WebStrings) => { title: string; detail: string }
  ): void {
    const copy = webCopy(request)

    this.html(
      response,
      200,
      oidcDonePage({
        ...copy,
        ...copyFor(copy.strings),
        issuerName: this.options.issuerName(),
        back: this.options.appPath
      })
    )
  }

  /**
   * The error page, in the language this request asked for.
   *
   * A method rather than ten call sites building the same object, because the
   * one thing they must not disagree about is which request the language came
   * from: an error page painted from somebody else's header would be a puzzle
   * nobody could reproduce.
   *
   * `sentence` picks the copy out of the table it belongs to, so a call site
   * names a key rather than a string; the failures that have no key — a
   * provider's own complaint about a malformed request — pass the message
   * through instead.
   */
  private failure(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    code: string,
    sentence: string | ((strings: WebStrings) => string)
  ): void {
    const copy = webCopy(request)

    this.html(
      response,
      status,
      oidcErrorPage({
        ...copy,
        code,
        detail: typeof sentence === 'string' ? sentence : sentence(copy.strings),
        issuerName: this.options.issuerName()
      })
    )
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)

    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store',
      pragma: 'no-cache'
    })
    response.end(payload)
  }
}

/**
 * Why this password will not do, or `''`.
 *
 * A length floor and nothing else. Composition rules — a digit, a symbol, a
 * capital — make passwords shorter and more predictable, which is NIST SP
 * 800-63B's own finding, and this provider has no list of breached passwords to
 * check against without a dependency and a download.
 */
export function passwordComplaint(password: string, again: string, strings: WebStrings = webStrings('en')): string {
  if (password.length < 12) {
    return strings.oidc.invite.tooShort
  }

  if (password !== again) {
    return strings.oidc.invite.mismatch
  }

  return ''
}

/** The invitation link an operator hands somebody, built on this service's origin. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin}${OIDC_PREFIX}/invite?token=${encodeURIComponent(token)}`
}
