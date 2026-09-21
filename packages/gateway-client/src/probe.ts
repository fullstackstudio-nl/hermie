import {
  type FetchLike,
  looksLikeCertificateFailure,
  parseJsonObject,
  requestText,
  type JsonResponse
} from './fetch-json'
import { classifyHost, hostOfAddress } from './host-privacy'
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

/**
 * Did this answer come from a different host than the one we asked?
 *
 * A redirect within one host is ordinary — a trailing slash, http to https on
 * the same name — and is followed without comment. A redirect to ANOTHER host
 * is a different server answering for an address the owner typed, and this
 * package will not follow one silently.
 *
 * The reason is a measured one. The iOS URL cache keeps a 301 keyed by bundle
 * id, and it survives deleting the app: a gateway that had moved from one
 * domain to another left a 301 behind, and months later a fresh install's very
 * first probe was answered out of that cache, reached the old host, and failed
 * as "that is not a Hermes gateway" — naming the address the owner had typed,
 * which was correct, rather than the one it had actually reached.
 */
function redirectedHost(response: JsonResponse, requested: string): string {
  if (!response.url) {
    // A platform that does not report the final URL. Nothing is claimed.
    return ''
  }

  const landed = hostOfAddress(response.url)
  const asked = hostOfAddress(requested)

  return landed && asked && landed !== asked ? landed : ''
}

/**
 * Does this body look like a landing page rather than a gateway's answer?
 *
 * Deliberately crude, and only ever used to ADD a sentence to a failure that
 * has already been decided. What it is looking for is the shape of a web page
 * where a JSON object was expected, which is what a reverse proxy's default
 * host, a parked domain and a marketing site all answer with.
 */
function looksLikeLandingPage(body: string): boolean {
  const head = body.slice(0, 2000).toLowerCase()

  return head.includes('<!doctype html') || head.includes('<html')
}

/**
 * The extra sentence for "answered, but not like a Hermes gateway".
 *
 * Two facts, and they are separate ones. WHAT came back — a web page where a
 * JSON object was expected — and WHERE the address points: a host only one
 * network can resolve or route to.
 *
 * They used to share a sentence, and the result was a claim the probe had no
 * grounds for. A landing page on a PUBLIC host was told "if the gateway is only
 * reachable on a private network or tailnet, make sure this device is connected
 * to it", which is a guess dressed as a diagnosis — a public name answering with
 * somebody's front page says nothing whatsoever about a tailnet, and it sent
 * readers to check a VPN when what they had was a typo or a proxy default host.
 *
 * So the network sentence is now only written for a host `host-privacy.ts` can
 * actually place on a network of its own, and the landing-page sentence says
 * only what was seen.
 *
 * Loopback is excluded from "a network of its own" for the obvious reason: the
 * device IS that network, so "make sure this device is connected to it" is
 * advice nobody can act on. A gateway that is meant to be on `localhost` and
 * is not is a process that is not running, not a network somebody has to join.
 */
export function notHermesHint(baseUrl: string, body: string): string {
  const privacy = classifyHost(baseUrl).privacy
  const reachableOnlyThere = privacy !== 'public' && privacy !== 'loopback'
  const landing = looksLikeLandingPage(body)
  const seen = landing ? 'This looks like a landing page, not a Hermes gateway.' : ''

  if (!reachableOnlyThere) {
    return seen
  }

  const network =
    'If the gateway is only reachable on that private network or tailnet, make sure this device is connected to it.'

  return seen ? `${seen} ${network}` : network
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
  const landedOn = redirectedHost(status, statusUrl)

  if (landedOn) {
    // Before every other verdict, including a 404 or a 200 that parses: WHERE
    // the answer came from decides what any of it means.
    throw new GatewayError(
      'redirect',
      `${hostOfAddress(statusUrl)} redirected to ${landedOn}, which is a different host. ` +
        'Nothing was read from it. Change the gateway address to the one you meant.',
      { status: status.status, redirectedTo: landedOn }
    )
  }

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

  const hint = notHermesHint(baseUrl, status.text)
  const withHint = (message: string): string => (hint ? `${message} ${hint}` : message)

  let body: Record<string, unknown>

  try {
    body = parseJsonObject(status.text, statusUrl, 'not_hermes')
  } catch (error) {
    // Re-thrown rather than let through, so the hint reaches the one failure
    // that most often means "this device is not on that network": a 200 with a
    // web page in it.
    throw new GatewayError(
      'not_hermes',
      withHint(isGatewayError(error) ? error.message : `${statusUrl} answered something that is not JSON.`),
      { cause: error, ...(hint ? { hint } : {}) }
    )
  }

  if (typeof body.auth_required !== 'boolean') {
    throw new GatewayError(
      'not_hermes',
      withHint(`${statusUrl} answered JSON without "auth_required" — not a Hermes gateway.`),
      hint ? { hint } : {}
    )
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

  if (error.kind === 'redirect') {
    // Something answered, and said where to go. Trying the other scheme would
    // most likely reach the same redirect and bury the one fact worth reporting.
    return false
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
    } catch (cleartextError) {
      /*
        A redirect found in the clear is reported as itself.

        Everything else here keeps the rule below — the https attempt is the one
        the user implied — but a redirect is not a failure to reach the address,
        it is the address telling us it has moved. Burying it under "could not
        reach over https" is what left the owner reading about a port they never
        asked about while the actual answer was "that name now points somewhere
        else".
      */
      if (isGatewayError(cleartextError) && cleartextError.kind === 'redirect') {
        throw cleartextError
      }

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
