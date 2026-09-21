import { type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import { bearerFrom, type CredentialProvider } from './credentials'
import { type FetchLike, parseJsonBody, requestText } from './fetch-json'
import { apiUrl, normalizeHeaders } from './url'
import { GatewayError } from './types'

/** Default window for one REST call once the gateway is configured. */
export const DEFAULT_REST_TIMEOUT_MS = 30_000

export interface GatewayHttpOptions {
  baseUrl: string
  credentials: CredentialProvider
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  defaultTimeoutMs?: number
  /** Where a 401 on a REST call is recorded. */
  timeline?: AuthTimelineSink
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface AuthIdentity {
  userId: string
  email: string
  displayName: string
  orgId: string
  provider: string
  expiresAt: number
}

export interface WsTicket {
  ticket: string
  ttlSeconds: number
}

/**
 * The REST half of a gateway connection: everything that is not the JSON-RPC
 * socket. It owns the one retry the auth contract allows — a 401 asks the
 * credential provider whether a fresh credential exists, and only then does the
 * call go out a second time.
 */
export class GatewayHttp {
  private readonly extraHeaders: Record<string, string>

  constructor(private readonly options: GatewayHttpOptions) {
    this.extraHeaders = normalizeHeaders(options.extraHeaders)
  }

  get baseUrl(): string {
    return this.options.baseUrl
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.send<T>('GET', path, undefined, options)
  }

  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('POST', path, body, options)
  }

  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('PUT', path, body, options)
  }

  /**
   * `PATCH`, which the profile rename route is the first caller of.
   *
   * Hermes spells that one `PATCH /api/profiles/{name}` and not
   * `POST …/rename`, so the verb has to exist here rather than being worked
   * around at the call site: everything that makes this class worth using —
   * the base URL, the extra headers, the credential provider and the single
   * 401 retry — lives inside `send`, and a hand-rolled `fetch` beside it would
   * have none of them.
   */
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('PATCH', path, body, options)
  }

  delete<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>('DELETE', path, body, options)
  }

  /** `GET /api/auth/me` — the identity check the wizard runs before it saves. */
  async authMe(options?: RequestOptions): Promise<AuthIdentity> {
    const body = await this.get<Record<string, unknown>>('/api/auth/me', options)

    return {
      userId: typeof body.user_id === 'string' ? body.user_id : '',
      email: typeof body.email === 'string' ? body.email : '',
      displayName: typeof body.display_name === 'string' ? body.display_name : '',
      orgId: typeof body.org_id === 'string' ? body.org_id : '',
      provider: typeof body.provider === 'string' ? body.provider : '',
      expiresAt: typeof body.expires_at === 'number' ? body.expires_at : 0
    }
  }

  /**
   * The headers a fetch this client does NOT make would still need.
   *
   * A Markdown image in a reply is loaded by the platform's own image loader,
   * not by this class, and a gated gateway answers 401 without them. Callers
   * are expected to resolve this once and hold the result: it mints nothing and
   * refreshes nothing, so a stale bearer here fails the way any other stale
   * bearer does, with a 401 the caller sees as a failed image.
   */
  async requestHeaders(): Promise<Record<string, string>> {
    return { ...this.extraHeaders, ...(await this.options.credentials.httpAuthHeaders()) }
  }

  /** `POST /api/auth/ws-ticket` — single-use, 30 s TTL, one per dial. */
  async wsTicket(options?: RequestOptions): Promise<WsTicket> {
    const body = await this.post<Record<string, unknown>>('/api/auth/ws-ticket', {}, options)

    if (typeof body.ticket !== 'string' || !body.ticket) {
      throw new GatewayError('protocol', 'The gateway answered /api/auth/ws-ticket without a ticket.')
    }

    return { ticket: body.ticket, ttlSeconds: typeof body.ttl_seconds === 'number' ? body.ttl_seconds : 0 }
  }

  private async send<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const attempt = await this.attempt(method, path, body, options, {})

    if (attempt.status !== 401) {
      return this.unwrap<T>(attempt, method, path)
    }

    ;(this.options.timeline ?? NULL_AUTH_TIMELINE).record({ event: 'rest.unauthorized', kind: 'auth', status: 401 })

    const verdict = await this.options.credentials.onRejected(attempt.usedToken)

    if (verdict === 'reauth') {
      throw new GatewayError('auth', `The gateway rejected the credentials for ${method} ${path}. Sign in again.`, {
        status: 401
      })
    }

    const retry = await this.attempt(method, path, body, options, { forceRefresh: false })

    return this.unwrap<T>(retry, method, path)
  }

  private async attempt(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
    authOptions: { forceRefresh?: boolean }
  ): Promise<{ status: number; ok: boolean; text: string; url: string; usedToken?: string }> {
    const url = apiUrl(this.options.baseUrl, path)
    const auth = await this.options.credentials.httpAuthHeaders(authOptions)
    const response = await requestText(url, {
      method,
      headers: { ...this.extraHeaders, ...auth },
      ...(body === undefined ? {} : { body }),
      ...(this.options.credentials.fetchCredentials === undefined
        ? {}
        : { credentials: this.options.credentials.fetchCredentials }),
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    })

    const usedToken = bearerFrom(auth)

    return { ...response, url, ...(usedToken === undefined ? {} : { usedToken }) }
  }

  private unwrap<T>(
    response: { status: number; ok: boolean; text: string; url: string },
    method: string,
    path: string
  ): T {
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError('auth', `The gateway refused ${method} ${path} (HTTP ${response.status}).`, {
        status: response.status
      })
    }

    if (response.status === 404) {
      throw new GatewayError('protocol', `The gateway has no ${method} ${path} endpoint (HTTP 404).`, { status: 404 })
    }

    if (response.status >= 500) {
      throw new GatewayError('server', `The gateway answered HTTP ${response.status} on ${method} ${path}.`, {
        status: response.status
      })
    }

    if (!response.ok) {
      throw new GatewayError('protocol', `${method} ${path} failed with HTTP ${response.status}.`, {
        status: response.status
      })
    }

    if (!response.text.trim()) {
      return undefined as T
    }

    // Object or array: a REST route may legitimately answer with either, and the
    // caller's own reader decides which it wanted (see `parseJsonBody`).
    return parseJsonBody(response.text, response.url, 'protocol') as T
  }
}
