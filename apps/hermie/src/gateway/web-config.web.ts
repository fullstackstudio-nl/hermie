/**
 * What the Hermie Web server tells the app about itself: `GET /hermie/config.json`.
 *
 * Two facts, and the app needs both for the same reason — the browser build has
 * no address step. The gateway is not something the user names; it is whatever
 * the server in front of this page proxies to. So the wizard SHOWS
 * `gatewayHost` instead of asking for it, and Settings shows `version` because
 * "which Hermie Web am I on" is otherwise unanswerable from inside the tab.
 *
 * The fetch is best-effort. A missing or malformed answer costs a label, never
 * a connection: the app still talks to its own origin, which is the one address
 * that cannot be wrong.
 */
import type { HermieWebConfig } from './web-config'

export type { HermieWebConfig } from './web-config'

export const WEB_GATEWAY_BASE_URL: string | null = typeof window === 'undefined' ? null : window.location.origin

let cached: Promise<HermieWebConfig | null> | null = null

export function loadHermieWebConfig(): Promise<HermieWebConfig | null> {
  if (!cached) {
    cached = fetchConfig().catch(() => null)
  }

  return cached
}

async function fetchConfig(): Promise<HermieWebConfig | null> {
  const response = await fetch('/hermie/config.json', { headers: { accept: 'application/json' } })

  if (!response.ok) {
    return null
  }

  const body = (await response.json()) as Partial<HermieWebConfig>

  return {
    gatewayHost: typeof body.gatewayHost === 'string' ? body.gatewayHost : '',
    version: typeof body.version === 'string' ? body.version : ''
  }
}
