/**
 * Turning the provider on, and the handful of things an operator does to an
 * account afterwards.
 *
 * These are pure state transitions — `(state, …) -> state` — with no HTTP and
 * no disk in them, so the admin routes that call them stay a thin layer of
 * forms and the rules live in one readable place. `/admin` owns the pages;
 * this owns what the pages mean.
 *
 * ## The TLS rule, and why it is upstream's rather than ours
 *
 * Enabling on a plain-`http` origin is refused, and not out of caution. The
 * relying party will not accept it either:
 *
 * ```python
 * def _require_https_or_loopback(url, *, field):
 *     if parsed.scheme == "https" or (parsed.scheme == "http" and (parsed.hostname or "") in ("localhost", "127.0.0.1", "::1")):
 *         return url
 *     raise ProviderError(f"OIDC {field} must be https:// (or http on localhost), got {url!r}")
 * ```
 *
 * So an operator who enabled this on `http://hermes.example.com:9120` would get
 * a provider that works in the browser and that the gateway refuses, which is
 * the worst of both. The check here fails at the moment they press the button,
 * with the reason. **Loopback http is allowed** — upstream allows it by name —
 * which is what makes local testing possible without a flag at all;
 * `--allow-insecure-oidc` is for the case upstream does NOT allow, and it
 * exists so somebody can reproduce that failure deliberately rather than by
 * accident.
 */
import { randomBytes } from 'node:crypto'

import { tokenDigest } from './jwt'
import { generateKey, type StoredKey } from './keys'
import { emptyOidcState, type OidcState } from './state'
import {
  findUser,
  hashPassword,
  newSub,
  normalizeUsername,
  type OidcRole,
  type OidcUser,
  type PasswordHash
} from './users'

/** How long an invitation link is good for. A working day, and then it is gone. */
export const INVITE_TTL_SECONDS = 24 * 3600

/** Is this an origin the gateway's own validator would accept as an issuer? */
export function issuerOriginAcceptable(origin: string): boolean {
  let url: URL

  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (url.protocol === 'https:') {
    return true
  }

  // The exact three names upstream allows on plain http. Not a hostname test
  // of our own: matching a wider set here would mean shipping a provider the
  // gateway refuses.
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
}

/**
 * The issuer this service would publish if it were enabled on this origin.
 *
 * One function rather than a string built twice, because `/admin/oidc` has to
 * be able to say "the issuer you are storing is not the one this address would
 * give you" — and it can only say that if both sides are derived the same way.
 */
export function issuerForOrigin(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/oidc`
}

export class OidcEnableError extends Error {}

export interface EnableInput {
  /** The origin `/admin` was reached on: scheme, host and port, no path. */
  origin: string
  /** The gateway's `dashboard.public_url`, for the one redirect URI. */
  gatewayPublicUrl: string
  /** Set by `--allow-insecure-oidc`; see the note above for what it is really for. */
  allowInsecure: boolean
  now?: number
  generate?: (now: number) => StoredKey
  random?: (size: number) => Buffer
}

/**
 * Turn the provider on: an issuer, a signing key and one registered client.
 *
 * Enabling a provider that is already enabled keeps its key, its client id and
 * its users — it is a re-enable, not a reset. Only the issuer and the redirect
 * URI are recomputed, because those are the two things an operator would be
 * pressing the button to correct.
 */
export function enableProvider(state: OidcState, input: EnableInput): OidcState {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const origin = input.origin.replace(/\/+$/, '')

  if (!issuerOriginAcceptable(origin) && !input.allowInsecure) {
    throw new OidcEnableError(
      `The gateway refuses an issuer that is not https (or http on loopback), so ${origin} would not work. ` +
        'Put TLS in front of this service, or start it with --allow-insecure-oidc if you are testing.'
    )
  }

  let gateway: URL

  try {
    gateway = new URL(input.gatewayPublicUrl)
  } catch {
    throw new OidcEnableError(`${input.gatewayPublicUrl} is not an address this issuer can call back to.`)
  }

  const base = state.v ? state : emptyOidcState()
  const keys = base.keys.length ? base.keys : [(input.generate ?? generateKey)(now)]
  /*
    The one redirect URI, and it is not a guess.

    Upstream builds it from `dashboard.public_url` and nothing else
    (`routes.py::_redirect_uri`), and refuses any redirect URI whose path does
    not end `/auth/callback` (`_shared.py::validate_redirect_uri`). The native
    app's loopback URI is deliberately NOT here: ADR-0004's flow is brokered by
    the gateway, so the identity provider never sees it. See `provider.ts`.
  */
  const callback = `${gateway.origin}${gateway.pathname.replace(/\/+$/, '')}/auth/callback`

  return {
    ...base,
    enabled: true,
    issuer: issuerForOrigin(origin),
    keys,
    client: {
      // Fixed per install, generated once. Two deployments never share one, and
      // it is regenerated only by disabling and re-enabling from scratch.
      clientId: base.client.clientId || `hermie-web-${(input.random ?? randomBytes)(8).toString('hex')}`,
      redirectUris: base.client.redirectUris.includes(callback)
        ? base.client.redirectUris
        : [callback, ...base.client.redirectUris],
      postLogoutRedirectUris: base.client.postLogoutRedirectUris
    }
  }
}

/**
 * Turn it off, keeping everything.
 *
 * Disabling is not deleting: the accounts, the key and the client id stay, so
 * an operator who turned it off to test something can turn it back on without
 * re-inviting everybody. Every refresh token IS dropped, because a provider
 * that is off should not be able to be refreshed through the moment it comes
 * back.
 */
export function disableProvider(state: OidcState): OidcState {
  return { ...state, enabled: false, refresh: [] }
}

export interface NewAccount {
  username: string
  email: string
  displayName: string
  role: OidcRole
  /** A password the operator chose, or none — in which case an invitation is minted. */
  password?: string
  now?: number
  random?: (size: number) => Buffer
}

export class OidcAccountError extends Error {}

/**
 * Create somebody.
 *
 * With no password an **invitation** is minted instead and returned once: the
 * operator sends the link, the person chooses their own password, and nobody
 * else ever knows it. That is the path the admin page offers first, because the
 * alternative ends with a password in a chat window.
 */
export function createAccount(
  state: OidcState,
  account: NewAccount
): { state: OidcState; user: OidcUser; inviteToken: string } {
  const username = normalizeUsername(account.username)

  if (!username || !/^[a-z0-9._@+-]{2,64}$/.test(username)) {
    throw new OidcAccountError('A username is two to sixty-four letters, digits or . _ @ + -')
  }

  if (findUser(state.users, username)) {
    throw new OidcAccountError(`${username} already has an account on this issuer.`)
  }

  const now = account.now ?? Math.floor(Date.now() / 1000)
  const random = account.random ?? randomBytes
  const inviteToken = account.password ? '' : random(24).toString('base64url')
  const password: PasswordHash | undefined = account.password ? hashPassword(account.password) : undefined

  const user: OidcUser = {
    sub: newSub(random),
    username,
    email: account.email.trim(),
    displayName: account.displayName.trim(),
    role: account.role,
    ...(password ? { password } : {}),
    totpSecret: '',
    recoveryCodes: [],
    disabled: false,
    createdAt: now,
    lastSignInAt: 0,
    ...(inviteToken ? { invite: { digest: tokenDigest(inviteToken), expiresAt: now + INVITE_TTL_SECONDS } } : {})
  }

  return { state: { ...state, users: [...state.users, user] }, user, inviteToken }
}

/** Mint a fresh invitation for somebody, replacing any password they had. */
export function resetToInvite(
  state: OidcState,
  sub: string,
  options: { now?: number; random?: (size: number) => Buffer } = {}
): { state: OidcState; inviteToken: string } {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const token = (options.random ?? randomBytes)(24).toString('base64url')

  return {
    state: {
      ...state,
      users: state.users.map(user =>
        user.sub === sub
          ? (({ password: _gone, ...rest }) => ({
              ...rest,
              invite: { digest: tokenDigest(token), expiresAt: now + INVITE_TTL_SECONDS }
            }))(user)
          : user
      ),
      // A password reset ends every session that was opened with the old one.
      refresh: state.refresh.filter(row => row.sub !== sub)
    },
    inviteToken: token
  }
}

/** Disable or re-enable somebody. Disabling drops their refresh tokens with them. */
export function setAccountDisabled(state: OidcState, sub: string, disabled: boolean): OidcState {
  return {
    ...state,
    users: state.users.map(user => (user.sub === sub ? { ...user, disabled } : user)),
    refresh: disabled ? state.refresh.filter(row => row.sub !== sub) : state.refresh
  }
}

export function setAccountRole(state: OidcState, sub: string, role: OidcRole): OidcState {
  return { ...state, users: state.users.map(user => (user.sub === sub ? { ...user, role } : user)) }
}

/** Take a second factor off an account, for the person who lost their phone. */
export function clearSecondFactor(state: OidcState, sub: string): OidcState {
  return {
    ...state,
    users: state.users.map(user => (user.sub === sub ? { ...user, totpSecret: '', recoveryCodes: [] } : user))
  }
}

/** Remove somebody entirely, with everything they hold. */
export function removeAccount(state: OidcState, sub: string): OidcState {
  return {
    ...state,
    users: state.users.filter(user => user.sub !== sub),
    refresh: state.refresh.filter(row => row.sub !== sub)
  }
}
