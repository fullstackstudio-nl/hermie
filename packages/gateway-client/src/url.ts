import { GatewayError } from './types'

/** Path the gateway serves its JSON-RPC WebSocket on. */
export const GATEWAY_WS_PATH = '/api/ws'

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
// RFC 9110 field-name = token.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Headers the app may not set: either the transport owns them (Host, Connection,
 * Upgrade, Content-Length, …) or letting a user override them would quietly
 * break authentication. `x-hermes-session-token` is on the list because the
 * credential provider mints it; a stale hand-typed copy would win otherwise.
 */
export const BLOCKED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-hermes-session-token'
])

/**
 * Did the user name a scheme themselves?
 *
 * The difference matters: an address typed WITHOUT one is a question the app
 * may answer by trying both, and an address typed WITH `https://` is an
 * instruction, never to be quietly downgraded.
 */
export function hasExplicitScheme(raw: string): boolean {
  return SCHEME_RE.test(raw.trim())
}

/**
 * Coerce what a user typed into a base URL:
 *
 * - no scheme → `https://`
 * - query, fragment and trailing slashes dropped
 * - a path prefix is kept (gateways behind a reverse proxy subpath)
 * - anything but http/https is a config error
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw new GatewayError('config', 'Enter a gateway address.')
  }

  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL

  try {
    url = new URL(withScheme)
  } catch (error) {
    throw new GatewayError('config', `That is not a valid address: ${trimmed}`, { cause: error })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayError('config', `A gateway address must be http:// or https://, not ${url.protocol}//`)
  }

  if (!url.hostname) {
    throw new GatewayError('config', `That address has no host: ${trimmed}`)
  }

  const path = url.pathname.replace(/\/+$/, '')

  return `${url.protocol}//${url.host}${path}`
}

/** `https://host/prefix` → `wss://host/prefix/api/ws`. Accepts an unnormalized base URL. */
export function wsUrlFor(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  const url = new URL(normalized)
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = url.pathname.replace(/\/+$/, '')

  return `${scheme}//${url.host}${prefix}${GATEWAY_WS_PATH}`
}

/** Join a path onto a base URL, keeping the base's path prefix. */
export function apiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  const suffix = path.startsWith('/') ? path : `/${path}`

  return `${normalized}${suffix}`
}

export function isBlockedHeaderName(name: string): boolean {
  return BLOCKED_HEADER_NAMES.has(name.trim().toLowerCase())
}

/**
 * Validate one extra header. Names must be RFC 9110 tokens and must not be one
 * of the transport-owned names; CR and LF are stripped from the value so a
 * pasted secret cannot smuggle a second header in behind it.
 */
export function normalizeHeader(name: string, value: string): [string, string] {
  const trimmedName = name.trim()

  if (!HEADER_NAME_RE.test(trimmedName)) {
    throw new GatewayError('config', `"${name}" is not a valid header name.`)
  }

  if (isBlockedHeaderName(trimmedName)) {
    throw new GatewayError('config', `Hermie sets "${trimmedName}" itself; it cannot be an extra header.`)
  }

  return [trimmedName, value.replace(/[\r\n]/g, '').trim()]
}

/** Validate a whole extra-header map; throws on the first offending entry. */
export function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) {
    return {}
  }

  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    const [safeName, safeValue] = normalizeHeader(name, value)
    out[safeName] = safeValue
  }

  return out
}
