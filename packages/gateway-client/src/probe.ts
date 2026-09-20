import { type FetchLike, looksLikeCertificateFailure, parseJsonObject, requestText } from './fetch-json'
import { apiUrl, hasExplicitScheme, normalizeBaseUrl, normalizeHeaders } from './url'
import { GatewayError, isGatewayError } from './types'

/** How long a probe waits for one HTTP answer before giving up. */
export const PROBE_TIMEOUT_MS = 10_000

/** The native PKCE flow id as advertised on `/api/status`. */
export const NATIVE_PKCE_FLOW = 'native_pkce'

export interface AuthProvider {
  name: string
  displayName: string
  supportsPassword: boolean
}

export interface ProbeResult {
  /** Gateway version string from `/api/status`. */
  version: string
  authRequired: boolean
  /** Raw `auth_flows`, e.g. `['cookie', 'native_pkce']`. */
  authFlows: string[]
  /** Empty for an ungated gateway, and for a gated one whose provider scan is down (503). */
  providers: AuthProvider[]
  supportsNativePkce: boolean
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/**
 * Read a gateway's public `/api/status` and, when it is gated, its provider
 * list. Everything here is unauthenticated: this is what the onboarding wizard
 * runs while the user is still typing an address.
 */
export async function probeGateway(
  baseUrl: string,
  extraHeaders: Record<string, string> = {},
  fetchImpl: FetchLike = fetch
): Promise<ProbeResult> {
  const headers = normalizeHeaders(extraHeaders)
  const statusUrl = apiUrl(baseUrl, '/api/status')
  const status = await requestText(statusUrl, { headers, fetchImpl, timeoutMs: PROBE_TIMEOUT_MS })

  if (status.status === 404) {
    throw new GatewayError('not_hermes', `${statusUrl} does not exist — that address is not a Hermes gateway.`, {
      status: 404
    })
  }

  if (status.status === 401 || status.status === 403) {
    throw new GatewayError(
      'auth',
      `${statusUrl} is behind an access proxy (HTTP ${status.status}). Add the proxy's headers under Advanced, ` +
        'or exempt /api/status, /auth/* and /login from it.',
      { status: status.status }
    )
  }

  if (status.status >= 500) {
    throw new GatewayError('server', `The gateway answered HTTP ${status.status} on /api/status.`, {
      status: status.status
    })
  }

  if (!status.ok) {
    throw new GatewayError('not_hermes', `${statusUrl} answered HTTP ${status.status}.`, { status: status.status })
  }

  const body = parseJsonObject(status.text, statusUrl, 'not_hermes')

  if (typeof body.auth_required !== 'boolean') {
    throw new GatewayError('not_hermes', `${statusUrl} answered JSON without "auth_required" — not a Hermes gateway.`)
  }

  const authFlows = asStringArray(body.auth_flows)
  const authRequired = body.auth_required
  const supportsNativePkce = authFlows.includes(NATIVE_PKCE_FLOW)
  const version = typeof body.version === 'string' ? body.version : ''

  if (!authRequired) {
    return { version, authRequired, authFlows, providers: [], supportsNativePkce }
  }

  return {
    version,
    authRequired,
    authFlows,
    supportsNativePkce,
    providers: await probeProviders(baseUrl, headers, fetchImpl)
  }
}

export interface ResolvedAddress extends ProbeResult {
  /** The address that answered, scheme included. */
  baseUrl: string
  /**
   * True when the user named no scheme, `https://` did not answer at all, and
   * the same host answered as a Hermes gateway over `http://`. The wizard says
   * so out loud: a downgrade nobody is told about is the thing to avoid here,
   * not the downgrade itself.
   */
  foundOverHttp: boolean
}

/**
 * Is this a failure to get an answer at all, as opposed to an answer we did not
 * like? Only the first is a reason to try the other scheme.
 *
 * Anything carrying an HTTP status is a server that spoke, and it spoke over
 * https — there is nothing to look for on the other port.
 *
 * A TLS failure is split. A rejected CERTIFICATE means there is a real https
 * server here and the user has a certificate to fix; retrying in the clear
 * would answer a question they did not ask. A handshake that failed because
 * the peer never spoke TLS is the opposite — it is what `hermes serve` on a
 * plain port looks like when you knock on it with `https://` — and that is
 * exactly the address this fallback exists for. Which of the two a platform
 * reports is a matter of its wording, so it is read from the underlying error
 * rather than from the sentence this package wrapped it in.
 */
function isTransportFailure(error: unknown): boolean {
  if (!isGatewayError(error) || error.status !== undefined) {
    return false
  }

  if (error.kind === 'network' || error.kind === 'timeout') {
    return true
  }

  if (error.kind === 'tls') {
    return !looksLikeCertificateFailure(error.cause instanceof Error ? error.cause.message : '')
  }

  return false
}

/**
 * Probe what the user typed, trying `http://` when they named no scheme and
 * `https://` did not answer.
 *
 * Hermes gateways on a tailnet are commonly served in the clear — WireGuard has
 * already encrypted the path — so "https or nothing" would make the ordinary
 * private setup fail with a network error and no hint. Typing `https://`
 * explicitly still means https and nothing else.
 */
export async function resolveGatewayAddress(
  raw: string,
  extraHeaders: Record<string, string> = {},
  fetchImpl: FetchLike = fetch
): Promise<ResolvedAddress> {
  const baseUrl = normalizeBaseUrl(raw)

  if (hasExplicitScheme(raw)) {
    return { ...(await probeGateway(baseUrl, extraHeaders, fetchImpl)), baseUrl, foundOverHttp: false }
  }

  try {
    return { ...(await probeGateway(baseUrl, extraHeaders, fetchImpl)), baseUrl, foundOverHttp: false }
  } catch (httpsError) {
    if (!isTransportFailure(httpsError)) {
      throw httpsError
    }

    const cleartextUrl = `http://${baseUrl.slice('https://'.length)}`

    try {
      return {
        ...(await probeGateway(cleartextUrl, extraHeaders, fetchImpl)),
        baseUrl: cleartextUrl,
        foundOverHttp: true
      }
    } catch {
      // The https attempt is the one the user implied, so its failure is the
      // one worth reading. Reporting the http error instead would send someone
      // chasing a port they never asked about.
      throw httpsError
    }
  }
}

async function probeProviders(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike
): Promise<AuthProvider[]> {
  const url = apiUrl(baseUrl, '/api/auth/providers')
  const response = await requestText(url, { headers, fetchImpl, timeoutMs: PROBE_TIMEOUT_MS })

  // The gateway answers 503 when its provider scan finds nothing usable. That
  // is a configuration story for the wizard, not a transport failure.
  if (response.status === 503) {
    return []
  }

  if (response.status === 401 || response.status === 403) {
    throw new GatewayError(
      'auth',
      `${url} is behind an access proxy (HTTP ${response.status}). Exempt /auth/* and /login from it.`,
      { status: response.status }
    )
  }

  if (response.status >= 500) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} on /api/auth/providers.`, {
      status: response.status
    })
  }

  if (!response.ok) {
    throw new GatewayError('not_hermes', `${url} answered HTTP ${response.status}.`, { status: response.status })
  }

  const body = parseJsonObject(response.text, url, 'not_hermes')
  const rows = Array.isArray(body.providers) ? body.providers : []

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map(row => ({
      name: typeof row.name === 'string' ? row.name : '',
      displayName: typeof row.display_name === 'string' ? row.display_name : String(row.name ?? ''),
      supportsPassword: row.supports_password === true
    }))
    .filter(provider => provider.name.length > 0)
}
