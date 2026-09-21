/**
 * How the daemon proves who it is, on each of the two kinds of gateway.
 *
 * ADR-0017: "Its credential is whatever the gateway takes." There are two, and
 * they authenticate differently enough that the difference cannot be hidden:
 *
 *  - **Ungated** — one session token, given on the command line or in the
 *    environment. It rides as `X-Hermes-Session-Token` on REST and as `?token=`
 *    on the upgrade. There is nothing to rotate, so a rejection is always "fix
 *    the token".
 *  - **OIDC-gated** — a refresh token obtained once by `hermie-web login` and
 *    kept in the state file. Every dial spends it for an access token and the
 *    access token for a single-use WebSocket ticket, because a gated gateway
 *    accepts no other credential on an upgrade. Rotation is the app's: a
 *    refresh answer carries a NEW refresh token and the old one is spent.
 *
 * The paths are the gateway's own, and they are the same ones
 * `packages/gateway-client/src/{native-auth,credentials,url}.ts` use — that
 * package is the specification for this file. It is not imported for the reason
 * `link.ts` explains: the released artefact carries no `node_modules`.
 */
import type { DialPlan } from './link'
import type { PushState, StoredRefreshToken } from './state'

/** The stable public subprotocol the gateway selects back on accept. */
export const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
/** Prefix of the credential-bearing subprotocol; never reflected back by the server. */
export const GATEWAY_WS_TICKET_PREFIX = 'hermes-gateway-ticket.'
/** Header an ungated gateway authenticates REST calls with. */
export const SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token'
/** Path the gateway serves its JSON-RPC WebSocket on. */
export const GATEWAY_WS_PATH = '/api/ws'

/** Refresh this long before the access token actually expires. */
export const REFRESH_SKEW_SECONDS = 60

export type FetchLike = typeof fetch

export interface PushCredentials {
  readonly mode: 'none' | 'token' | 'oidc'
  /** Auth headers for one REST call. */
  httpHeaders(): Promise<Record<string, string>>
  /** Everything one dial needs, minted immediately before it happens. */
  dial(): Promise<DialPlan>
}

/** `http://host/prefix` → `ws://host/prefix/api/ws`. */
export function gatewayWsUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl)
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = url.pathname.replace(/\/+$/, '')

  return `${scheme}//${url.host}${prefix}${GATEWAY_WS_PATH}`
}

/** Join a path onto the gateway's base URL, keeping any path prefix. */
export function gatewayApiUrl(gatewayUrl: string, suffix: string): string {
  const url = new URL(gatewayUrl)
  const prefix = url.pathname.replace(/\/+$/, '')

  return `${url.protocol}//${url.host}${prefix}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

/** An ungated gateway, or one behind a network the operator already trusts. */
export class NoCredentials implements PushCredentials {
  readonly mode = 'none' as const

  constructor(private readonly gatewayUrl: string) {}

  async httpHeaders(): Promise<Record<string, string>> {
    return {}
  }

  async dial(): Promise<DialPlan> {
    return { url: gatewayWsUrl(this.gatewayUrl) }
  }
}

export class SessionTokenCredentials implements PushCredentials {
  readonly mode = 'token' as const

  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string
  ) {}

  async httpHeaders(): Promise<Record<string, string>> {
    return { [SESSION_TOKEN_HEADER]: this.token }
  }

  async dial(): Promise<DialPlan> {
    const url = new URL(gatewayWsUrl(this.gatewayUrl))
    url.searchParams.set('token', this.token)

    return { url: url.toString() }
  }
}

export class PushAuthError extends Error {
  /** True when signing in again is the only way out. */
  readonly fatal: boolean

  constructor(message: string, options: { fatal?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PushAuthError'
    this.fatal = options.fatal ?? false
  }
}

export interface OidcCredentialsOptions {
  gatewayUrl: string
  /** The stored grant. Replaced in place on every rotation. */
  stored: StoredRefreshToken
  /** Persist the rotated refresh token. A rotation that is not written is a grant lost on restart. */
  persist: (tokens: StoredRefreshToken) => Promise<void>
  fetchImpl?: FetchLike
  now?: () => number
}

/**
 * The only statuses that mean "this grant is finished, sign in again".
 *
 * Copied from `gateway-client/src/native-auth.ts` together with the reason it is
 * a list and not "anything that is not ok": 408 and 429 are statements about the
 * moment, and a daemon that deleted its refresh token because a proxy throttled
 * a burst would need a human at a terminal to come back.
 */
const DEFINITIVE_REFRESH_STATUSES = new Set([400, 401, 403])

export class OidcCredentials implements PushCredentials {
  readonly mode = 'oidc' as const

  private accessToken = ''
  private expiresAt = 0
  private stored: StoredRefreshToken
  private rotating: Promise<void> | null = null

  constructor(private readonly options: OidcCredentialsOptions) {
    this.stored = options.stored
  }

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl ?? fetch
  }

  private get now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  async httpHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.access()}` }
  }

  async dial(): Promise<DialPlan> {
    const ticket = await this.mintTicket()

    return {
      url: gatewayWsUrl(this.options.gatewayUrl),
      protocols: [GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}${ticket}`]
    }
  }

  /** A valid access token, refreshing when it is inside the skew window. */
  private async access(): Promise<string> {
    if (this.accessToken && (!this.expiresAt || this.now < this.expiresAt - REFRESH_SKEW_SECONDS)) {
      return this.accessToken
    }

    // Concurrent callers share one rotation: two refreshes racing would spend
    // the grant twice and upstream treats a reused refresh token as an attack.
    this.rotating ??= this.rotate().finally(() => {
      this.rotating = null
    })

    await this.rotating

    return this.accessToken
  }

  private async rotate(): Promise<void> {
    const url = gatewayApiUrl(this.options.gatewayUrl, '/auth/native/refresh')
    let response: Response

    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refresh_token: this.stored.refreshToken, provider: this.stored.provider })
      })
    } catch (error) {
      throw new PushAuthError(`The gateway could not be reached to refresh the sign-in: ${String(error)}`)
    }

    if (DEFINITIVE_REFRESH_STATUSES.has(response.status)) {
      throw new PushAuthError('The stored sign-in has expired. Run `hermie-web login` again.', { fatal: true })
    }

    if (response.status === 404) {
      throw new PushAuthError('This gateway has no /auth/native/refresh endpoint (HTTP 404).', { fatal: true })
    }

    if (!response.ok) {
      throw new PushAuthError(`The gateway answered HTTP ${response.status} while refreshing the sign-in.`)
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const accessToken = typeof body.access_token === 'string' ? body.access_token : ''

    if (!accessToken) {
      throw new PushAuthError('The gateway refreshed the sign-in without returning an access token.')
    }

    this.accessToken = accessToken
    this.expiresAt = typeof body.expires_at === 'number' ? body.expires_at : 0

    const rotated = typeof body.refresh_token === 'string' ? body.refresh_token : ''

    if (rotated && rotated !== this.stored.refreshToken) {
      this.stored = { ...this.stored, refreshToken: rotated }
      await this.options.persist(this.stored)
    }
  }

  /** One ticket for one dial: single-use, 30 s TTL. */
  private async mintTicket(): Promise<string> {
    const url = gatewayApiUrl(this.options.gatewayUrl, '/api/auth/ws-ticket')
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { ...(await this.httpHeaders()), 'content-type': 'application/json' },
      body: '{}'
    })

    if (response.status === 401 || response.status === 403) {
      throw new PushAuthError('The gateway refused to mint a WebSocket ticket. Run `hermie-web login` again.', {
        fatal: true
      })
    }

    if (!response.ok) {
      throw new PushAuthError(`The gateway answered HTTP ${response.status} while minting a WebSocket ticket.`)
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (typeof body.ticket !== 'string' || !body.ticket) {
      throw new PushAuthError(`${url} answered without a ticket.`)
    }

    return body.ticket
  }
}

export interface ResolveCredentialsInput {
  gatewayUrl: string
  /** `--gateway-token`, or `HERMIE_GATEWAY_TOKEN`. */
  token?: string | undefined
  state: PushState
  persist: (tokens: StoredRefreshToken) => Promise<void>
  fetchImpl?: FetchLike
}

/**
 * Which credential this run uses.
 *
 * A token beats a stored sign-in, because a token was given deliberately on this
 * invocation and a stored grant is left over from an earlier one. A stored grant
 * for a DIFFERENT gateway is ignored rather than tried: ADR-0017 is explicit
 * that a registration — and by the same argument a credential — is only
 * meaningful for the gateway it was made on.
 */
export function resolveCredentials(input: ResolveCredentialsInput): PushCredentials {
  if (input.token) {
    return new SessionTokenCredentials(input.gatewayUrl, input.token)
  }

  const stored = input.state.oidc

  if (stored && sameGateway(stored.gateway, input.gatewayUrl)) {
    return new OidcCredentials({
      gatewayUrl: input.gatewayUrl,
      stored,
      persist: input.persist,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    })
  }

  return new NoCredentials(input.gatewayUrl)
}

/** Two addresses for the same gateway, compared the way a credential should be. */
export function sameGateway(a: string, b: string): boolean {
  try {
    const left = new URL(a)
    const right = new URL(b)

    return left.host === right.host && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}
