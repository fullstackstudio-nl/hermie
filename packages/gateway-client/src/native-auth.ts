import { type FetchLike, parseJsonObject, requestText } from './fetch-json'
import { apiUrl, normalizeHeaders } from './url'
import { GatewayError } from './types'

/** Refresh this long before the access token actually expires. */
export const REFRESH_SKEW_SECONDS = 60

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** Unix seconds, as the gateway reports it. */
  expiresAt: number
  provider: string
  userId: string
}

/** Where the app keeps the token set. On device this is the platform secret store. */
export interface TokenStore {
  load(): Promise<TokenSet | null>
  save(tokens: TokenSet): Promise<void>
  clear(): Promise<void>
}

export interface NativeAuthOptions {
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  timeoutMs?: number
}

function toTokenSet(body: Record<string, unknown>, url: string): TokenSet {
  const accessToken = body.access_token
  const refreshToken = body.refresh_token

  if (typeof accessToken !== 'string' || !accessToken) {
    throw new GatewayError('protocol', `${url} answered without an access_token.`)
  }

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at : 0,
    provider: typeof body.provider === 'string' ? body.provider : '',
    userId: typeof body.user_id === 'string' ? body.user_id : ''
  }
}

/**
 * Redeem the one-time loopback code for bearer tokens. The gateway consumes the
 * code on every path, so a failure here is final: start a new sign-in rather
 * than retrying the exchange.
 */
export async function exchangeCode(
  baseUrl: string,
  params: { code: string; verifier: string },
  options: NativeAuthOptions = {}
): Promise<TokenSet> {
  const url = apiUrl(baseUrl, '/auth/native/token')
  const response = await requestText(url, {
    method: 'POST',
    headers: normalizeHeaders(options.extraHeaders),
    body: { code: params.code, code_verifier: params.verifier },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  })

  if (response.status === 400) {
    throw new GatewayError('auth', 'That sign-in code was already used or has expired. Sign in again.', {
      status: 400
    })
  }

  if (response.status >= 500) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} while exchanging the code.`, {
      status: response.status
    })
  }

  if (!response.ok) {
    throw new GatewayError('auth', `The code exchange failed with HTTP ${response.status}.`, {
      status: response.status
    })
  }

  return toTokenSet(parseJsonObject(response.text, url, 'protocol'), url)
}

/**
 * Rotate a refresh token. A 401 means every provider rejected it and the user
 * has to sign in again; a 503 means the identity provider is unreachable and
 * the same refresh token is still worth retrying later.
 */
export async function refreshTokens(
  baseUrl: string,
  tokens: Pick<TokenSet, 'refreshToken' | 'provider'>,
  options: NativeAuthOptions = {}
): Promise<TokenSet> {
  const url = apiUrl(baseUrl, '/auth/native/refresh')

  if (!tokens.refreshToken) {
    throw new GatewayError('auth', 'There is no refresh token to rotate. Sign in again.', { status: 401 })
  }

  const response = await requestText(url, {
    method: 'POST',
    headers: normalizeHeaders(options.extraHeaders),
    body: { refresh_token: tokens.refreshToken, provider: tokens.provider },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  })

  if (response.status === 401) {
    throw new GatewayError('auth', 'Your session has expired. Sign in again.', { status: 401 })
  }

  if (response.status === 503) {
    throw new GatewayError('server', 'The identity provider is unreachable; Hermie will keep retrying.', {
      status: 503
    })
  }

  if (response.status >= 500) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} while refreshing.`, {
      status: response.status
    })
  }

  if (!response.ok) {
    throw new GatewayError('auth', `The refresh failed with HTTP ${response.status}.`, { status: response.status })
  }

  return toTokenSet(parseJsonObject(response.text, url, 'protocol'), url)
}

/** True once the access token is inside the proactive-refresh window. */
export function tokenNeedsRefresh(tokens: TokenSet, nowSeconds: number, skew = REFRESH_SKEW_SECONDS): boolean {
  if (!tokens.expiresAt) {
    return false
  }

  return tokens.expiresAt - nowSeconds < skew
}

/** Thrown when a sign-in or sign-out landed while a refresh was in flight. */
export class AuthChangedError extends Error {
  constructor() {
    super('Authentication changed while the request was in progress. Try again.')
    this.name = 'AuthChangedError'
  }
}

export interface TokenCoordinatorOptions {
  store: TokenStore
  refresh: (tokens: TokenSet) => Promise<TokenSet>
  nowSeconds?: () => number
  skewSeconds?: number
  /** A refresh failure that means "sign in again" rather than "try later". */
  isAuthRejection?: (error: unknown) => boolean
}

export interface AccessTokenOptions {
  forceRefresh?: boolean
  /**
   * The access token that just got a 401. A late 401 must join a rotation that
   * is already running rather than rotate its winner a second time.
   */
  rejectedAccessToken?: string
}

/**
 * Ported from the Hermes Desktop native access-token coordinator: one owner for
 * refresh flights, with an auth epoch so a sign-in or sign-out that lands
 * mid-flight cannot be overwritten by the rotation it raced.
 *
 * Hermie talks to exactly one gateway, so the desktop's per-host maps collapse
 * into single fields.
 */
export class TokenCoordinator {
  private readonly options: Required<Omit<TokenCoordinatorOptions, 'store' | 'refresh'>> &
    Pick<TokenCoordinatorOptions, 'store' | 'refresh'>
  private refreshFlight: Promise<string | null> | null = null
  private authEpoch = 0
  /** Memo of the stored set; the secret store is slow and asked on every request. */
  private cached: TokenSet | null | undefined
  private loadFlight: Promise<TokenSet | null> | null = null

  constructor(options: TokenCoordinatorOptions) {
    this.options = {
      store: options.store,
      refresh: options.refresh,
      nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
      skewSeconds: options.skewSeconds ?? REFRESH_SKEW_SECONDS,
      isAuthRejection:
        options.isAuthRejection ?? ((error: unknown) => error instanceof GatewayError && error.kind === 'auth')
    }
  }

  /** The token set as stored, without refreshing anything. */
  async current(): Promise<TokenSet | null> {
    if (this.cached !== undefined) {
      return this.cached
    }

    if (!this.loadFlight) {
      this.loadFlight = this.options.store.load().then(loaded => {
        this.cached = loaded
        this.loadFlight = null

        return loaded
      })
    }

    return this.loadFlight
  }

  /**
   * An access token that is good to use right now: the stored one when it is
   * still comfortably valid, otherwise the result of a single shared rotation.
   * `null` means the user has to sign in again.
   */
  async accessToken(options: AccessTokenOptions = {}): Promise<string | null> {
    const existingFlight = this.refreshFlight

    if (existingFlight) {
      return existingFlight
    }

    const tokens = await this.current()

    if (!tokens) {
      return null
    }

    // A 401 for a token that is no longer the stored one was already handled by
    // whoever rotated it; hand back the current token instead of rotating again.
    const rejectedCurrent = !options.rejectedAccessToken || options.rejectedAccessToken === tokens.accessToken

    if (
      !(options.forceRefresh && rejectedCurrent) &&
      !tokenNeedsRefresh(tokens, this.options.nowSeconds(), this.options.skewSeconds)
    ) {
      return tokens.accessToken
    }

    if (!tokens.refreshToken) {
      await this.clear()

      return null
    }

    // Reading the secret store is async, so a second caller can arrive between
    // the load and the decision. Re-check before opening a second rotation:
    // both callers awaited the same load, so their continuations run in order
    // and the loser finds the winner's flight here.
    const raced = this.refreshFlight

    if (raced) {
      return raced
    }

    return this.startRefresh(tokens)
  }

  /** Persist a freshly minted token set and fence any refresh in flight. */
  async save(tokens: TokenSet): Promise<void> {
    this.beginAuthChange()
    this.cached = tokens
    await this.options.store.save(tokens)
  }

  /** Forget the tokens and fence any refresh in flight. */
  async clear(): Promise<void> {
    this.beginAuthChange()
    this.cached = null
    await this.options.store.clear()
  }

  private beginAuthChange(): void {
    this.authEpoch += 1
    this.refreshFlight = null
    this.loadFlight = null
  }

  private startRefresh(tokens: TokenSet): Promise<string | null> {
    const flightEpoch = this.authEpoch

    const assertCurrent = () => {
      if (this.authEpoch !== flightEpoch) {
        throw new AuthChangedError()
      }
    }

    const flight = (async (): Promise<string | null> => {
      let rotated: TokenSet

      try {
        rotated = await this.options.refresh(tokens)
      } catch (error) {
        assertCurrent()

        if (this.options.isAuthRejection(error)) {
          await this.clear()

          return null
        }

        throw error
      }

      assertCurrent()
      this.cached = rotated
      await this.options.store.save(rotated)

      return rotated.accessToken
    })()

    this.refreshFlight = flight

    return flight.finally(() => {
      if (this.refreshFlight === flight) {
        this.refreshFlight = null
      }
    })
  }
}
