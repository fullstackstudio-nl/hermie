/**
 * The vocabulary every other module in this package speaks: what a connection
 * can be doing, how a failure is named, and the two configuration records the
 * app hands in.
 */

/**
 * Where the connection is right now. `probing` and `authenticating` are pre-dial
 * states; `needs_signin` and `incompatible` are terminal until the app acts.
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'probing'
  | 'authenticating'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'paused'
  | 'offline'
  | 'needs_signin'
  | 'incompatible'

/**
 * Why something failed, in terms the UI can turn into one sentence and — where
 * one exists — a server-side fix.
 *
 * - `network`   DNS, refused, unreachable.
 * - `tls`       certificate or handshake failure; retrying does not help.
 * - `timeout`   no answer inside the window.
 * - `auth`      credentials rejected or missing.
 * - `config`    the gateway refused us on purpose (host/origin guard, chat off).
 * - `server`    5xx, the gateway is up but unhappy.
 * - `protocol`  a well-formed HTTP answer that broke the JSON-RPC contract.
 * - `not_hermes` something answered, but it is not a Hermes gateway.
 * - `incompatible` it is a Hermes gateway, but too old for this client.
 */
export type GatewayErrorKind =
  'network' | 'tls' | 'timeout' | 'auth' | 'config' | 'server' | 'protocol' | 'not_hermes' | 'incompatible'

export interface GatewayErrorOptions {
  cause?: unknown
  /** HTTP status, when the failure came from a response. */
  status?: number
  /** WebSocket close code, when the failure came from a socket. */
  closeCode?: number
}

/**
 * An `Error` subclass so it can be thrown and caught the ordinary way, with the
 * classification fields the connection state machine and the UI both branch on.
 */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly status?: number
  readonly closeCode?: number

  constructor(kind: GatewayErrorKind, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GatewayError'
    this.kind = kind
    this.status = options.status
    this.closeCode = options.closeCode
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError
}

/**
 * Wrap anything thrown into a `GatewayError` without losing an existing
 * classification.
 */
export function asGatewayError(value: unknown, fallbackKind: GatewayErrorKind, fallbackMessage: string): GatewayError {
  if (isGatewayError(value)) {
    return value
  }

  const message = value instanceof Error && value.message ? value.message : fallbackMessage

  return new GatewayError(fallbackKind, message, { cause: value })
}

/**
 * Everything needed to open one WebSocket, minted immediately before the dial:
 * gated gateways hand out single-use tickets with a 30 s TTL, so a plan is never
 * reused across dials.
 */
export interface DialPlan {
  url: string
  protocols?: string[]
  headers?: Record<string, string>
}

/**
 * How this client proves who it is to a gateway.
 *
 * - `native_pkce`   RFC 8252 sign-in, `Authorization: Bearer` on REST.
 * - `session_token` an ungated gateway's shared secret.
 * - `cookie`        the gateway's own browser session. Only reachable from a
 *   page the gateway (or a proxy in front of it, which is what Hermie Web is)
 *   serves on the SAME origin: the credential is an HttpOnly cookie the app
 *   can neither read nor attach by hand.
 */
export type GatewayAuthMode = 'native_pkce' | 'session_token' | 'cookie'

/** The non-secret half of a configured gateway. Secrets live in the credential provider. */
export interface GatewayConfig {
  baseUrl: string
  authMode: GatewayAuthMode
  /** Auth provider name for the native flow (`/api/auth/providers` → `name`). */
  provider?: string
  /** Extra headers for every fetch and WebSocket dial (Cloudflare Access and friends). */
  extraHeaders?: Record<string, string>
}
