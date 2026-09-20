import { type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import { type FetchLike, parseJsonObject, requestText } from './fetch-json'
import { type TokenCoordinator } from './native-auth'
import { apiUrl, normalizeHeaders } from './url'
import { type DialPlan, type GatewayAuthMode, GatewayError } from './types'

/** The stable public subprotocol the gateway selects back on accept. */
export const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
/** Prefix of the credential-bearing subprotocol; never reflected back by the server. */
export const GATEWAY_WS_TICKET_PREFIX = 'hermes-gateway-ticket.'
/** Header an ungated gateway authenticates REST calls with. */
export const SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token'

export interface AuthHeaderOptions {
  forceRefresh?: boolean
  rejectedAccessToken?: string
}

/**
 * What the HTTP layer and the dial loop need from "however this gateway
 * authenticates us", so neither has to know which of the two flows is in play.
 */
export interface CredentialProvider {
  readonly mode: GatewayAuthMode
  /** Auth headers for one REST call. */
  httpAuthHeaders(options?: AuthHeaderOptions): Promise<Record<string, string>>
  /** Mint everything one WebSocket dial needs. Called immediately before connecting. */
  dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan>
  /**
   * A credential was rejected (HTTP 401 or WS close 4401). `retry` means a fresh
   * credential is available and the caller should try once more; `reauth` means
   * the user has to sign in again.
   */
  onRejected(rejectedToken?: string): Promise<'retry' | 'reauth'>
  signOut(): Promise<void>
}

/** Pull the bearer value back out of a header map, for 401 bookkeeping. */
export function bearerFrom(headers: Record<string, string>): string | undefined {
  const value = headers.authorization ?? headers.Authorization

  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined
}

export interface NativePkceCredentialsOptions {
  baseUrl: string
  coordinator: TokenCoordinator
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  /** Where the mint record goes, so a 4401 can be read next to the ticket it refused. */
  timeline?: AuthTimelineSink
}

/**
 * Gated gateway: `Authorization: Bearer` on REST, and a single-use ticket in the
 * WebSocket subprotocol list — browsers cannot set headers on an upgrade, so the
 * gateway made the ticket the only WS credential it accepts when gated.
 */
export class NativePkceCredentials implements CredentialProvider {
  readonly mode: GatewayAuthMode = 'native_pkce'

  constructor(private readonly options: NativePkceCredentialsOptions) {}

  async httpAuthHeaders(options: AuthHeaderOptions = {}): Promise<Record<string, string>> {
    const token = await this.options.coordinator.accessToken(options)

    if (!token) {
      throw new GatewayError('auth', 'You are signed out of this gateway. Sign in again.', { status: 401 })
    }

    return { authorization: `Bearer ${token}` }
  }

  async dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan> {
    const ticket = await this.mintTicket(extraHeaders)

    return {
      url: wsUrl,
      protocols: [GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}${ticket}`],
      headers: extraHeaders
    }
  }

  async onRejected(rejectedToken?: string): Promise<'retry' | 'reauth'> {
    const refreshed = await this.options.coordinator.accessToken({
      forceRefresh: true,
      ...(rejectedToken === undefined ? {} : { rejectedAccessToken: rejectedToken })
    })

    return refreshed ? 'retry' : 'reauth'
  }

  async signOut(): Promise<void> {
    await this.options.coordinator.clear()
  }

  /**
   * One ticket for one dial.
   *
   * This is the ONLY place in a dial where an expired access token shows itself:
   * the mint is an ordinary authenticated POST, so upstream's gate answers 401
   * here, whereas the WebSocket upgrade verifies no token at all and can only
   * ever refuse the ticket. The two must stay distinguishable, which is why the
   * mint's status is recorded.
   */
  private async mintTicket(extraHeaders: Record<string, string>): Promise<string> {
    const timeline = this.options.timeline ?? NULL_AUTH_TIMELINE
    const url = apiUrl(this.options.baseUrl, '/api/auth/ws-ticket')
    const auth = await this.httpAuthHeaders()
    let response

    try {
      response = await requestText(url, {
        method: 'POST',
        headers: { ...normalizeHeaders(this.options.extraHeaders), ...extraHeaders, ...auth },
        body: {},
        fetchImpl: this.options.fetchImpl
      })
    } catch (error) {
      timeline.record({
        event: 'ticket.failed',
        ...(error instanceof GatewayError ? { kind: error.kind } : {})
      })

      throw error
    }

    if (response.status === 401 || response.status === 403) {
      timeline.record({ event: 'ticket.failed', kind: 'auth', status: response.status })

      throw new GatewayError('auth', 'The gateway refused to mint a WebSocket ticket. Sign in again.', {
        status: response.status
      })
    }

    if (response.status >= 500) {
      timeline.record({ event: 'ticket.failed', kind: 'server', status: response.status })

      throw new GatewayError('server', `The gateway answered HTTP ${response.status} while minting a ticket.`, {
        status: response.status
      })
    }

    if (!response.ok) {
      timeline.record({ event: 'ticket.failed', kind: 'protocol', status: response.status })

      throw new GatewayError('protocol', `Minting a WebSocket ticket failed with HTTP ${response.status}.`, {
        status: response.status
      })
    }

    const body = parseJsonObject(response.text, url, 'protocol')

    if (typeof body.ticket !== 'string' || !body.ticket) {
      timeline.record({ event: 'ticket.failed', kind: 'protocol', status: response.status })

      throw new GatewayError('protocol', `${url} answered without a ticket.`)
    }

    timeline.record({ event: 'ticket.minted' })

    return body.ticket
  }
}

export interface SessionTokenCredentialsOptions {
  token: string
}

/**
 * Ungated gateway: the session token rides as a header on REST and as `?token=`
 * on the WebSocket. There is nothing to refresh, so a rejection is always a
 * "fix the token" story.
 */
export class SessionTokenCredentials implements CredentialProvider {
  readonly mode: GatewayAuthMode = 'session_token'

  constructor(private readonly options: SessionTokenCredentialsOptions) {}

  async httpAuthHeaders(): Promise<Record<string, string>> {
    return { [SESSION_TOKEN_HEADER]: this.options.token }
  }

  async dialPlan(wsUrl: string, extraHeaders: Record<string, string>): Promise<DialPlan> {
    const url = new URL(wsUrl)
    url.searchParams.set('token', this.options.token)

    return { url: url.toString(), headers: extraHeaders }
  }

  async onRejected(): Promise<'retry' | 'reauth'> {
    return 'reauth'
  }

  async signOut(): Promise<void> {
    // Nothing is cached here; the app clears the stored token itself.
  }
}
