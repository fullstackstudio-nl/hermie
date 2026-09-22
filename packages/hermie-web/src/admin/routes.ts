/**
 * `/admin` and its forms, as one handler the server hands a request to.
 *
 * Kept out of `server.ts` because that file is already the routing table for
 * three other things, and because everything here shares one shape: read the
 * state, check the gate, check the token, change exactly one thing, redirect.
 *
 * The order of the checks is load-bearing and is the same on every POST:
 *
 *  1. **The gate**, freshly — `/api/auth/me` with `{ fresh: true }`, so an
 *     administrator who was removed or signed out a minute ago does not get one
 *     more write out of a memo.
 *  2. **The CSRF token**, before the body is parsed, so a cross-site post costs
 *     nothing and reaches nothing.
 *  3. **The change**, one per route, then a redirect with a notice. A redirect
 *     rather than a rendered answer, because a reload of a rendered POST is the
 *     way an operator repeats an action they only meant once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GatewayIdentity, IdentityReader } from '../identity'
import { webCopy } from '../i18n'
import { isSecureRequest } from '../proxy'
import { PUSH_TYPES, type PushType } from '../push/registrations'
import {
  clearSecondFactor,
  createAccount,
  disableProvider,
  enableProvider,
  issuerOriginAcceptable,
  type OidcAccountError,
  type OidcEnableError,
  removeAccount,
  resetToInvite,
  setAccountDisabled,
  setAccountRole
} from '../oidc/accounts'
import { inviteUrl } from '../oidc/routes'
import { runSelfTest, type SelfTestStep } from '../oidc/selftest'
import type { OidcProvider } from '../oidc/provider'
import type { OidcState } from '../oidc/state'
import type { OidcRole } from '../oidc/users'
import { ownOrigin } from '../setup'
import { identityPage } from './identity'
import { isAdminIdentity, localSecretMatches, withAdmin, withoutAdmin } from './access'
import {
  adminBrandingPage,
  adminCachePage,
  adminDangerPage,
  adminFeaturesPage,
  adminForbiddenPage,
  adminOverviewPage,
  adminPeoplePage,
  adminPushPage,
  adminResetConfirmPage,
  adminSignInPage,
  brandOf,
  type ResetChoices,
  type AdminPageInput,
  type AdminStatus
} from './page'
import {
  ADMIN_SESSION_COOKIE,
  AdminSessions,
  CSRF_COOKIE,
  CSRF_FIELD,
  cookieOf,
  newToken,
  setCookie,
  tokensMatch
} from './session'
import { saveAdminState, type AdminState } from './state'

/** At most 64 KiB of form body. More than that is not one of these forms. */
const MAX_FORM_BYTES = 64 * 1024

/**
 * Which GET path draws which page.
 *
 * A table rather than a chain of `if`s, so an unknown `/admin/…` path answers
 * 404 instead of silently drawing the overview — which is what a chain ending in
 * a default does, and what would make a typo in a bookmark look like a page that
 * lost its contents. `/admin/oidc` is not here: it takes a different input.
 */
/**
 * Where each POST sends the browser afterwards.
 *
 * The page the form was on, so a notice lands beside the control it is about.
 * Everything still redirects rather than rendering — a rendered POST is repeated
 * by pressing F5, which is how an operator clears a cache twice — and the only
 * thing that changed is that the destination is no longer always `/admin`.
 */
const POST_RETURNS: Record<string, string | undefined> = {
  '/admin/push': '/admin/push',
  '/admin/cache': '/admin/cache',
  '/admin/branding': '/admin/branding',
  '/admin/flags': '/admin/features',
  '/admin/user': '/admin/people',
  '/admin/update': '/admin/danger'
}

const ADMIN_PAGES: Record<string, ((input: AdminPageInput) => string) | undefined> = {
  '/admin': adminOverviewPage,
  '/admin/people': adminPeoplePage,
  '/admin/push': adminPushPage,
  '/admin/cache': adminCachePage,
  '/admin/branding': adminBrandingPage,
  '/admin/features': adminFeaturesPage,
  '/admin/danger': adminDangerPage
}

export interface AdminRouterOptions {
  stateDir: string
  /**
   * The state as the SERVER holds it, not as the file has it.
   *
   * There is one authority in this process and it is the variable in
   * `startHermieWeb`. The router used to re-read the file on every request,
   * which is a second authority and therefore a race: `noteSeen` updates memory
   * synchronously and writes the file in the background, so a page rendered in
   * between showed a list that was one visitor out of date.
   */
  read: () => AdminState
  gatewayUrl: () => string
  identities: IdentityReader
  /** Everything the status panel reports. Read fresh on every render. */
  status: () => Promise<AdminStatus>
  /** Bot names for the allow-list placeholder; `[]` where the roster is unknown. */
  bots: () => string[]
  /** Clear the message cache. The one action that is not a settings write. */
  clearCache: () => Promise<void>
  /** Run the self-update. Answers a message; the page shows it. */
  update: () => Promise<string>
  /**
   * Throw away what `/setup` wrote, and say whether `/setup` is open again.
   *
   * It answers `setupOpen: false` on a deployment whose gateway came from
   * `--gateway` or the environment: the flag still names one, so there is
   * nothing for the setup page to decide and it stays closed. The page says so
   * before the operator presses the button rather than afterwards.
   */
  resetSetup: (choices: ResetChoices) => Promise<{ setupOpen: boolean }>
  /** Whether a reset would reopen `/setup`. Asked before anything is deleted. */
  setupReopens: () => boolean
  /** Told whenever the state changed, so the server can re-read what it caches. */
  onChanged: (state: AdminState) => void
  sessions?: AdminSessions
  /** The built-in identity provider (ADR-0025 part 3) and what it needs to be set up. */
  oidc: {
    provider: OidcProvider
    read: () => OidcState
    /** `--allow-insecure-oidc`. See the option's note for what it is really for. */
    allowInsecure: boolean
    /** The gateway's `dashboard.public_url`, which decides the one redirect URI. */
    gatewayPublicUrl: () => string
    /** Injected by the tests so a self-test never leaves the process. */
    fetchImpl?: typeof fetch
  }
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

const checked = (form: URLSearchParams, name: string): boolean => form.get(name) === '1'

export class AdminRouter {
  private readonly sessions: AdminSessions
  /**
   * The last invitation minted and the last self-test's steps, in memory.
   *
   * Held rather than rendered straight out of the POST so that every form on
   * this page can keep redirecting: a rendered POST is reloaded by pressing
   * F5, and a reloaded self-test would re-submit somebody's password. They are
   * shown once and cleared on the next render, which is also what makes an
   * invitation link genuinely a one-time sight.
   */
  private pendingInvite: { username: string; url: string } | null = null
  private lastSelfTest: SelfTestStep[] = []

  constructor(private readonly options: AdminRouterOptions) {
    this.sessions = options.sessions ?? new AdminSessions()
  }

  /** Every path this router owns. Checked before the proxy sees the request. */
  owns(pathname: string): boolean {
    return pathname === '/admin' || pathname.startsWith('/admin/')
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase()
    const state = this.options.read()
    const identity = await this.options.identities.read({
      gatewayUrl: this.options.gatewayUrl(),
      cookie: request.headers.cookie,
      fresh: true
    })

    // The local sign-in is the one route reachable without being an
    // administrator yet, and only on a service that has a secret to check.
    if (url.pathname === '/admin/sign-in') {
      await this.signIn(request, response, state, method)

      return
    }

    if (!this.allowed(request, state, identity)) {
      await this.refuse(request, response, state, identity)

      return
    }

    if (method === 'GET') {
      const notice = url.searchParams.get('notice') ?? ''

      if (url.pathname === '/admin/oidc') {
        await this.renderIdentity(request, response, notice)

        return
      }

      const page = ADMIN_PAGES[url.pathname]

      if (!page) {
        this.json(response, 404, { error: 'not_found' })

        return
      }

      await this.render(request, response, state, identity, notice, page)

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
      this.json(response, 403, { error: 'bad_request', detail: (error as Error).message })

      return
    }

    await this.apply(request, response, state, identity, url.pathname, form, ownOrigin(request))
  }

  /** Whether this request may see the page at all. */
  private allowed(request: IncomingMessage, state: AdminState, identity: GatewayIdentity | null): boolean {
    if (isAdminIdentity(state, identity)) {
      return true
    }

    return Boolean(state.localAdmin) && this.sessions.has(cookieOf(request.headers.cookie, ADMIN_SESSION_COOKIE))
  }

  private async refuse(
    request: IncomingMessage,
    response: ServerResponse,
    state: AdminState,
    identity: GatewayIdentity | null
  ): Promise<void> {
    const copy = webCopy(request)

    if (state.localAdmin) {
      // A deployment with a local secret offers the way in rather than a wall:
      // its whole point is that there is no gateway account to recognise.
      this.html(
        response,
        401,
        adminSignInPage({ csrf: this.mintCsrf(response, false), notice: '', brand: brandOf(state), ...copy })
      )

      return
    }

    this.html(response, 403, adminForbiddenPage({ viewer: identity?.userId ?? '', brand: brandOf(state), ...copy }))
  }

  private async signIn(
    request: IncomingMessage,
    response: ServerResponse,
    state: AdminState,
    method: string
  ): Promise<void> {
    if (method !== 'POST' || !state.localAdmin) {
      this.json(response, 404, { error: 'not_found' })

      return
    }

    let form: URLSearchParams

    try {
      form = await this.checkedForm(request)
    } catch (error) {
      this.json(response, 403, { error: 'bad_request', detail: (error as Error).message })

      return
    }

    if (!localSecretMatches(state, form.get('secret') ?? '')) {
      const copy = webCopy(request)

      // The same page again, with the same generic line. Nothing here says
      // whether a secret exists, how long it is, or how close this one was.
      this.html(
        response,
        401,
        adminSignInPage({
          csrf: this.mintCsrf(response, isSecureRequest(request)),
          notice: copy.strings.admin.signIn.wrongSecret,
          brand: brandOf(state),
          ...copy
        })
      )

      return
    }

    const value = this.sessions.create()

    response.writeHead(303, {
      location: '/admin',
      'cache-control': 'no-store',
      'set-cookie': [
        setCookie(ADMIN_SESSION_COOKIE, value, { secure: isSecureRequest(request), httpOnly: true }),
        setCookie(CSRF_COOKIE, newToken(), { secure: isSecureRequest(request), httpOnly: false })
      ]
    })
    response.end()
  }

  /** The body, but only once the double-submit token has matched. */
  private async checkedForm(request: IncomingMessage): Promise<URLSearchParams> {
    const cookie = cookieOf(request.headers.cookie, CSRF_COOKIE)
    const form = await readForm(request)

    if (!tokensMatch(cookie, form.get(CSRF_FIELD) ?? '')) {
      throw new Error('that form did not carry this page’s token')
    }

    return form
  }

  private async render(
    request: IncomingMessage,
    response: ServerResponse,
    state: AdminState,
    identity: GatewayIdentity | null,
    notice: string,
    page: (input: AdminPageInput) => string
  ): Promise<void> {
    this.html(
      response,
      200,
      page({
        state,
        status: await this.options.status(),
        csrf: this.mintCsrf(response, isSecureRequest(request)),
        bots: this.options.bots(),
        viewer: identity?.userId ?? '',
        identity: this.identitySummary(),
        notice,
        ...webCopy(request)
      })
    )
  }

  private async apply(
    request: IncomingMessage,
    response: ServerResponse,
    state: AdminState,
    identity: GatewayIdentity | null,
    pathname: string,
    form: URLSearchParams,
    origin: string
  ): Promise<void> {
    const back = POST_RETURNS[pathname] ?? '/admin'

    switch (pathname) {
      case '/admin/push': {
        const types = Object.fromEntries(PUSH_TYPES.map(type => [type, checked(form, `type-${type}`)])) as Record<
          PushType,
          boolean
        >

        await this.save(
          response,
          { ...state, push: { types, preview: form.get('preview') === 'never' ? 'never' : 'device' } },
          'Saved.',
          back
        )

        return
      }

      case '/admin/cache': {
        if (form.get('clear') === '1') {
          await this.options.clearCache()
          this.done(response, 'The message cache was cleared.', back)

          return
        }

        const hours = Math.max(0, Math.floor(Number(form.get('retentionHours') ?? 0) || 0))

        await this.save(response, { ...state, cache: { retentionHours: hours } }, 'Saved.', back)

        return
      }

      case '/admin/branding':
        await this.save(
          response,
          {
            ...state,
            branding: {
              name: (form.get('name') ?? '').trim().slice(0, 64),
              accent: (form.get('accent') ?? '').trim().slice(0, 32),
              theme: (form.get('theme') ?? '').trim().slice(0, 32)
            }
          },
          'Saved.',
          back
        )

        return

      case '/admin/flags':
        await this.save(
          response,
          {
            ...state,
            flags: {
              userChats: checked(form, 'userChats'),
              messageCache: checked(form, 'messageCache'),
              selfUpdate: checked(form, 'selfUpdate')
            }
          },
          'Saved.',
          back
        )

        return

      case '/admin/user':
        await this.saveUser(response, state, identity, form, back)

        return

      case '/admin/oidc/enable':
        await this.oidcEnable(response, form, origin)

        return

      case '/admin/oidc/recapture':
        await this.oidcRecapture(response, origin)

        return

      case '/admin/oidc/settings':
        await this.oidcSettings(response, form)

        return

      case '/admin/oidc/redirects':
        await this.oidcRedirects(response, form)

        return

      case '/admin/oidc/rotate': {
        const key = await this.options.oidc.provider.rotateKeys()

        this.doneAt('/admin/oidc', `A new signing key is in use. Its kid is ${key.kid}.`)(response)

        return
      }

      case '/admin/oidc/user':
        await this.oidcUser(response, form, origin)

        return

      case '/admin/oidc/test':
        await this.oidcTest(response, form)

        return

      case '/admin/reset-setup':
        await this.resetSetup(request, response, state, form)

        return

      case '/admin/update': {
        const message = await this.options.update().catch((error: unknown) => String(error))

        this.done(response, message, back)

        return
      }

      default:
        this.json(response, 404, { error: 'not_found' })
    }
  }

  /**
   * Starting the setup over: ask first, then do it.
   *
   * One route and two steps, told apart by the `confirm` field, because a
   * confirmation that lives on another route is one somebody can reach by
   * typing it. The first step renders the list of consequences; the second is
   * the only thing in this file that deletes an operator's configuration, and it
   * is reached only from a form that carried this page's own token.
   */
  private async resetSetup(
    request: IncomingMessage,
    response: ServerResponse,
    state: AdminState,
    form: URLSearchParams
  ): Promise<void> {
    const choices: ResetChoices = { cache: checked(form, 'alsoCache'), push: checked(form, 'alsoPush') }

    if (!checked(form, 'confirm')) {
      const status = await this.options.status()

      this.html(
        response,
        200,
        adminResetConfirmPage({
          state,
          status,
          csrf: this.mintCsrf(response, isSecureRequest(request)),
          bots: this.options.bots(),
          viewer: '',
          identity: this.identitySummary(),
          notice: '',
          choices,
          setupOpens: this.options.setupReopens(),
          ...webCopy(request)
        })
      )

      return
    }

    const { setupOpen } = await this.options.resetSetup(choices)

    /*
      Out of `/admin` entirely where the setup page is open again.

      There is nothing on the other side of this: the administrator list is
      empty and the local secret is gone, so the next GET of `/admin` is a
      refusal. Sending the operator to the page that can fix that is the only
      useful thing left to do.
    */
    response.writeHead(303, {
      location: setupOpen
        ? '/setup'
        : `/admin?notice=${encodeURIComponent(
            'The setup was cleared. The gateway came from the command line, so it was kept and /setup stays closed.'
          )}`,
      'cache-control': 'no-store'
    })
    response.end()
  }

  /**
   * The provider, as the pages want it: a count, and a row-by-row lookup.
   *
   * Built per render rather than held, because it is a view of the provider's
   * own state and a second copy of that is a second authority.
   */
  private identitySummary(): AdminPageInput['identity'] {
    const state = this.options.oidc.read()

    return {
      enabled: state.enabled,
      issuer: state.issuer,
      accounts: state.users.length,
      bySub: state.enabled
        ? Object.fromEntries(
            state.users.map(user => [user.sub, { username: user.username, admin: user.role === 'admin' }])
          )
        : {}
    }
  }

  private async saveUser(
    response: ServerResponse,
    state: AdminState,
    identity: GatewayIdentity | null,
    form: URLSearchParams,
    back: string
  ): Promise<void> {
    const userId = (form.get('userId') ?? '').trim()

    if (!userId) {
      this.done(response, 'A person needs a gateway user id.', back)

      return
    }

    const wantsAdmin = checked(form, 'admin')
    const account = this.options.oidc.read().enabled
      ? this.options.oidc.read().users.find(user => user.sub === userId)
      : undefined

    /*
      An account on this service's own issuer has ONE administrator switch.

      Its `sub` is the gateway user id (see `people.ts`), so the row here and the
      account on `/admin/oidc` are the same person. Writing the id straight into
      `admins` would be a second answer that the next reconcile would silently
      undo, so the role is what changes and the reconcile mirrors it back — which
      also means this page and the identity page can never disagree.
    */
    if (account && (account.role === 'admin') !== wantsAdmin) {
      await this.options.oidc.provider.update(next =>
        setAccountRole(next, userId, wantsAdmin ? 'admin' : ('user' as OidcRole))
      )
    }

    // Re-read: the reconcile that follows an account's role change rewrites the
    // administrator list and may have added this very row.
    state = this.options.read()

    const raw = (form.get('allowedBots') ?? '').trim()
    const held = state.users[userId]
    const next: AdminState = {
      ...state,
      users: {
        ...state.users,
        [userId]: {
          userId,
          displayName: held?.displayName ?? '',
          email: held?.email ?? '',
          seenAt: held?.seenAt ?? 0,
          // Blank is "every bot" and a list is a list. There is no way to say
          // "no bots" by typing nothing, which is the right way round: the
          // accident an operator can have is emptying a field.
          allowedBots: raw
            ? raw
                .split(',')
                .map(name => name.trim())
                .filter(Boolean)
            : null,
          readOnly: checked(form, 'readOnly'),
          pushAllowed: checked(form, 'pushAllowed'),
          ...(held?.fromIssuer ? { fromIssuer: true } : {})
        }
      }
    }

    if (account) {
      // The role already decided the administrator list; everything else on this
      // form is a service-level option and is saved as it stands.
      await this.save(response, next, 'Saved.', back)

      return
    }

    const isAdmin = state.admins.includes(userId)

    if (wantsAdmin && !isAdmin) {
      await this.save(response, withAdmin(next, userId), 'Saved.', back)

      return
    }

    if (!wantsAdmin && isAdmin) {
      const { state: after, removed } = withoutAdmin(next, userId)

      await this.save(
        response,
        after,
        removed
          ? userId === identity?.userId
            ? 'Saved. You are no longer an administrator of this service.'
            : 'Saved.'
          : 'Saved, but the last administrator cannot be removed.',
        back
      )

      return
    }

    await this.save(response, next, 'Saved.', back)
  }

  // ---- the built-in identity provider (ADR-0025 part 3) ----

  /**
   * Render `/admin/oidc`, consuming whatever was meant to be seen once.
   *
   * The invitation link and the self-test result are cleared as they are drawn,
   * so a second visit shows neither. That is the whole reason they are held in
   * memory rather than put in the redirect's query string, where they would sit
   * in the browser's history and in any proxy log on the way.
   */
  private async renderIdentity(request: IncomingMessage, response: ServerResponse, notice: string): Promise<void> {
    const state = this.options.oidc.read()
    const origin = ownOrigin(request)
    const invite = this.pendingInvite
    const selfTest = this.lastSelfTest
    const status = await this.options.status()

    this.pendingInvite = null
    this.lastSelfTest = []

    this.html(
      response,
      200,
      identityPage({
        state,
        csrf: this.mintCsrf(response, isSecureRequest(request)),
        origin,
        gatewayPublicUrl: this.options.oidc.gatewayPublicUrl(),
        allowInsecure: this.options.oidc.allowInsecure,
        originAcceptable: issuerOriginAcceptable(origin),
        invite,
        selfTest,
        notice,
        chrome: {
          brand: brandOf(this.options.read()),
          version: status.version,
          canSelfUpdate: status.canSelfUpdate,
          updateReason: status.updateReason
        },
        ...webCopy(request)
      })
    )
  }

  private async oidcEnable(response: ServerResponse, form: URLSearchParams, origin: string): Promise<void> {
    if (form.get('enabled') !== '1') {
      await this.options.oidc.provider.update(disableProvider)
      this.doneAt('/admin/oidc', 'The identity provider is off. Accounts and keys were kept.')(response)

      return
    }

    try {
      const next = await this.options.oidc.provider.update(state =>
        enableProvider(state, {
          // The issuer is the origin the OPERATOR reached this page on, not one
          // derived from a flag: it is the address a browser can actually come
          // back to, and every token will carry it as `iss` for ever after.
          origin,
          gatewayPublicUrl: this.options.oidc.gatewayPublicUrl(),
          allowInsecure: this.options.oidc.allowInsecure
        })
      )

      this.doneAt(
        '/admin/oidc',
        `The identity provider is on at ${next.issuer}. It changed nothing on the gateway — the snippet below is what to put there.`
      )(response)
    } catch (error) {
      this.doneAt('/admin/oidc', (error as OidcEnableError).message)(response)
    }
  }

  /**
   * Take the issuer from the address this page was reached on, keeping the rest.
   *
   * It is the enable transition with nothing else changed, which is the point:
   * an operator whose reverse proxy dropped the port used to have to turn the
   * provider OFF and back ON to correct the issuer, and turning it off drops
   * every refresh token — so a fix for a typo in an address signed out every
   * device in the deployment. `enableProvider` on an already-enabled state
   * recomputes the issuer and the redirect URI and touches neither the keys, the
   * client id, the accounts nor the refresh list, so there is nothing to spend
   * here and the off/on is no longer the only way.
   *
   * What it CANNOT do is tell the gateway. Every token minted from now on
   * carries the new `iss`, and a gateway still configured with the old one
   * refuses it — which is why the notice sends the operator to the snippet.
   */
  private async oidcRecapture(response: ServerResponse, origin: string): Promise<void> {
    if (!this.options.oidc.read().enabled) {
      this.doneAt('/admin/oidc', 'The identity provider is off, so there is no issuer to re-capture.')(response)

      return
    }

    try {
      const next = await this.options.oidc.provider.update(state =>
        enableProvider(state, {
          origin,
          gatewayPublicUrl: this.options.oidc.gatewayPublicUrl(),
          allowInsecure: this.options.oidc.allowInsecure
        })
      )

      this.doneAt(
        '/admin/oidc',
        `The issuer is now ${next.issuer}. Accounts, keys and sessions were kept — put the issuer below in the ` +
          'gateway’s configuration and restart it.'
      )(response)
    } catch (error) {
      this.doneAt('/admin/oidc', (error as OidcEnableError).message)(response)
    }
  }

  private async oidcSettings(response: ServerResponse, form: URLSearchParams): Promise<void> {
    const number = (name: string, floor: number, fallback: number): number => {
      const value = Math.floor(Number(form.get(name) ?? fallback))

      return Number.isFinite(value) && value >= floor ? value : fallback
    }

    await this.options.oidc.provider.update(state => ({
      ...state,
      settings: {
        ...state.settings,
        requireTotp: checked(form, 'requireTotp'),
        idTokenTtlSeconds: number('idTokenTtlSeconds', 60, state.settings.idTokenTtlSeconds),
        refreshTokenTtlSeconds: number('refreshTokenTtlSeconds', 300, state.settings.refreshTokenTtlSeconds)
      }
    }))

    this.doneAt('/admin/oidc', 'Saved.')(response)
  }

  private async oidcRedirects(response: ServerResponse, form: URLSearchParams): Promise<void> {
    const uris = (form.get('redirectUris') ?? '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    if (!uris.length) {
      // An empty list is a provider nothing can sign in through, which is a
      // state an operator reaches by clearing a box rather than by choosing.
      this.doneAt('/admin/oidc', 'A redirect URI is required; nothing was changed.')(response)

      return
    }

    await this.options.oidc.provider.update(state => ({
      ...state,
      client: { ...state.client, redirectUris: uris }
    }))

    this.doneAt('/admin/oidc', 'Saved.')(response)
  }

  /** Create, invite, disable, re-enable, re-role, clear a second factor, remove. */
  private async oidcUser(response: ServerResponse, form: URLSearchParams, origin: string): Promise<void> {
    const action = form.get('do') ?? ''
    const sub = (form.get('sub') ?? '').trim()

    try {
      if (action === 'create') {
        let minted = ''
        let username = ''

        await this.options.oidc.provider.update(state => {
          const created = createAccount(state, {
            username: form.get('username') ?? '',
            email: form.get('email') ?? '',
            displayName: form.get('displayName') ?? '',
            role: form.get('role') === 'admin' ? 'admin' : 'user'
          })

          minted = created.inviteToken
          username = created.user.username

          return created.state
        })

        this.pendingInvite = { username, url: inviteUrl(origin, minted) }
        this.doneAt('/admin/oidc', `${username} was created. Send them the invitation link below.`)(response)

        return
      }

      if (!sub) {
        this.doneAt('/admin/oidc', 'Nothing was named.')(response)

        return
      }

      switch (action) {
        case 'invite': {
          let minted = ''

          const next = await this.options.oidc.provider.update(state => {
            const reset = resetToInvite(state, sub)
            minted = reset.inviteToken

            return reset.state
          })

          // Every session that was opened with the old password ends with it.
          this.options.oidc.provider.endSessionsFor(sub)
          this.pendingInvite = {
            username: next.users.find(user => user.sub === sub)?.username ?? sub,
            url: inviteUrl(origin, minted)
          }
          this.doneAt('/admin/oidc', 'Their password was cleared. Send them the link below.')(response)

          return
        }

        case 'disable':
        case 'enable': {
          const off = action === 'disable'

          await this.options.oidc.provider.update(state => setAccountDisabled(state, sub, off))

          if (off) {
            this.options.oidc.provider.endSessionsFor(sub)
          }

          this.doneAt('/admin/oidc', off ? 'That account is disabled.' : 'That account is active again.')(response)

          return
        }

        case 'role':
          await this.options.oidc.provider.update(state =>
            setAccountRole(state, sub, (form.get('role') === 'admin' ? 'admin' : 'user') as OidcRole)
          )
          this.doneAt('/admin/oidc', 'Saved.')(response)

          return

        case 'clear-totp':
          await this.options.oidc.provider.update(state => clearSecondFactor(state, sub))
          this.doneAt(
            '/admin/oidc',
            'Their second factor is off. They can enrol a new one at their next sign-in.'
          )(response)

          return

        case 'remove':
          await this.options.oidc.provider.update(state => removeAccount(state, sub))
          this.options.oidc.provider.endSessionsFor(sub)
          this.doneAt('/admin/oidc', 'That account is gone, with everything it held.')(response)

          return

        default:
          this.doneAt('/admin/oidc', 'That is not something this page does.')(response)
      }
    } catch (error) {
      this.doneAt('/admin/oidc', (error as OidcAccountError).message)(response)
    }
  }

  /**
   * Run the round trip and hold the result for the render after the redirect.
   *
   * The credentials live in this call and nowhere else: they are not written to
   * the state, not put in the redirect, and not logged.
   */
  private async oidcTest(response: ServerResponse, form: URLSearchParams): Promise<void> {
    const state = this.options.oidc.read()

    if (!state.enabled) {
      this.doneAt('/admin/oidc', 'The identity provider is off, so there is nothing to test.')(response)

      return
    }

    this.lastSelfTest = await runSelfTest({
      issuer: state.issuer,
      clientId: state.client.clientId,
      redirectUri: state.client.redirectUris[0] ?? '',
      username: form.get('username') ?? '',
      password: form.get('password') ?? '',
      totp: form.get('totp') ?? '',
      ...(this.options.oidc.fetchImpl ? { fetchImpl: this.options.oidc.fetchImpl } : {})
    }).catch((error: unknown) => [{ name: 'Test sign-in', ok: false, detail: String(error) }])

    this.doneAt('/admin/oidc', 'The test sign-in ran; each step is below.')(response)
  }

  /** `done`, but back to a page that is not `/admin`. */
  private doneAt(path: string, notice: string): (response: ServerResponse) => void {
    return response => {
      response.writeHead(303, {
        location: `${path}?notice=${encodeURIComponent(notice)}`,
        'cache-control': 'no-store'
      })
      response.end()
    }
  }

  private async save(response: ServerResponse, state: AdminState, notice = 'Saved.', at = '/admin'): Promise<void> {
    await saveAdminState(this.options.stateDir, state)
    this.options.onChanged(state)
    this.done(response, notice, at)
  }

  /** One mint per render, so a token never outlives the page that carries it. */
  private mintCsrf(response: ServerResponse, secure: boolean): string {
    const value = newToken()

    response.setHeader('set-cookie', setCookie(CSRF_COOKIE, value, { secure, httpOnly: false }))

    return value
  }

  private done(response: ServerResponse, notice: string, at = '/admin'): void {
    response.writeHead(303, { location: `${at}?notice=${encodeURIComponent(notice)}`, 'cache-control': 'no-store' })
    response.end()
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

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)

    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store'
    })
    response.end(payload)
  }
}
