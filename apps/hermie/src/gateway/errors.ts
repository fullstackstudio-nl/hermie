import { isGatewayError } from '@hermie/gateway-client'

import { strings } from '../i18n/strings'

/**
 * One sentence per failure, and where the gateway's own configuration is the
 * cause, the fix that belongs on the server rather than in the app.
 *
 * There are two tables rather than one because the same classification means
 * different things at different moments. `/api/status` is public, so an `auth`
 * failure there is an access proxy standing in front of the gateway; once the
 * app is authenticating, the same kind means the credentials were refused.
 */

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.trim() || strings.settings.unknown
  }
}

function fallbackMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return strings.errors.unknown
}

/** The unauthenticated probe the address step runs while the user is typing. */
export function describeProbeError(error: unknown, baseUrl: string): string {
  if (!isGatewayError(error)) {
    return fallbackMessage(error)
  }

  const host = hostOf(baseUrl)

  switch (error.kind) {
    case 'network':
      return strings.errors.network(host)
    case 'tls':
      return strings.errors.tls(host)
    case 'timeout':
      return strings.errors.timeout(host)
    case 'not_hermes':
      return strings.errors.notHermes(host)
    case 'auth':
      return strings.errors.authProxy(error.status ?? 401)
    case 'server':
      return strings.errors.server(error.status ?? 500)
    case 'incompatible':
      return strings.errors.incompatible
    case 'config':
      // A config error here is the address the user typed, and the gateway
      // client already phrased it precisely ("that is not a valid address: …").
      return error.message
    default:
      return error.message || strings.errors.unknown
  }
}

/** An authenticated attempt: the REST calls and the WebSocket dial. */
export function describeConnectionError(error: unknown, baseUrl: string): string {
  if (!isGatewayError(error)) {
    return fallbackMessage(error)
  }

  // Close codes are the most specific thing the gateway tells us, so they win
  // over the kind the client derived from them.
  switch (error.closeCode) {
    case 4401:
      return strings.errors.closeAuth
    case 4403:
      return strings.errors.closeHost
    case 4408:
      return strings.errors.closeTakenOver
    case 4404:
      return strings.errors.closeChatOff
    case 1006:
      return strings.errors.closeAbnormal
    default:
      break
  }

  switch (error.kind) {
    case 'auth':
      return strings.errors.signedOut
    case 'network':
      return strings.errors.network(hostOf(baseUrl))
    case 'tls':
      return strings.errors.tls(hostOf(baseUrl))
    case 'timeout':
      return strings.errors.timeout(hostOf(baseUrl))
    case 'not_hermes':
      return strings.errors.notHermes(hostOf(baseUrl))
    case 'server':
      return strings.errors.server(error.status ?? 500)
    case 'incompatible':
      return strings.errors.incompatible
    default:
      return error.message || strings.errors.unknown
  }
}

/**
 * The PKCE code exchange and refresh. The gateway client already phrases these
 * precisely — "that sign-in code was already used or has expired" tells the user
 * what to do in a way a generic "credentials refused" does not — so an
 * authentication failure keeps its own wording here.
 */
export function describeSignInError(error: unknown, baseUrl: string): string {
  if (isGatewayError(error) && (error.kind === 'auth' || error.kind === 'config')) {
    return error.message
  }

  return describeConnectionError(error, baseUrl)
}
