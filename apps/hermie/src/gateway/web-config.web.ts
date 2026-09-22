/**
 * What the Hermie Web server tells the app about itself: `GET /hermie/config.json`.
 *
 * It began as three labels and is now the browser build's BOOTSTRAP
 * ([ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)). The
 * gateway is not something a reader names — it is whatever the server in front
 * of this page proxies to — so the wizard does not ask for it, and since the
 * server has already read that gateway's `/api/status` it does not have to ask
 * what signing in to it takes either. `loginReturn` is where the server wants a
 * finished sign-in to land (`cookie-sign-in.web.ts` is the only thing that
 * reads it), `version` answers "which Hermie Web am I on" from inside the tab,
 * and `service` says whether the server's own gateway link is up.
 *
 * The fetch stays best-effort, and that is a decision rather than an omission:
 * a missing or malformed answer costs a label and a shortcut, never a
 * connection. The app still talks to its own origin — the one address that
 * cannot be wrong — and a sign-in step with no `authKinds` probes the gateway
 * itself, exactly as this build did before the field existed.
 */
import type { AuthProvider } from '@hermie/gateway-client'

import type { HermieWebConfig, HermieWebService } from './web-config'

export type { HermieWebConfig, HermieWebService } from './web-config'
export { probeFromWebConfig } from './web-config'

export const WEB_GATEWAY_BASE_URL: string | null = typeof window === 'undefined' ? null : window.location.origin

let cached: Promise<HermieWebConfig | null> | null = null

export function loadHermieWebConfig(): Promise<HermieWebConfig | null> {
  if (!cached) {
    cached = fetchConfig().catch(() => null)
  }

  return cached
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A list of strings, or `null` for anything that is not one — including a missing field. */
function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null
}

function providersOrNull(value: unknown): AuthProvider[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map(row => ({
      name: str(row.name),
      displayName: str(row.displayName) || str(row.name),
      supportsPassword: row.supportsPassword === true
    }))
    .filter(provider => provider.name.length > 0)
}

function serviceOf(value: unknown): HermieWebService {
  const row = (Boolean(value) && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return { login: row.login === true, push: row.push === true, cache: row.cache === true }
}

async function fetchConfig(): Promise<HermieWebConfig | null> {
  const response = await fetch('/hermie/config.json', { headers: { accept: 'application/json' } })

  if (!response.ok) {
    return null
  }

  const body = (await response.json()) as Record<string, unknown>

  return {
    gatewayHost: str(body.gatewayHost),
    // An older Hermie Web serving a newer bundle answers without it; the host
    // on its own is still a truthful label, just not a qualified one.
    gatewayOrigin: str(body.gatewayOrigin),
    loginReturn: str(body.loginReturn),
    version: str(body.version),
    setupRequired: body.setupRequired === true,
    authRequired: typeof body.authRequired === 'boolean' ? body.authRequired : null,
    authKinds: stringsOrNull(body.authKinds),
    providers: providersOrNull(body.providers),
    service: serviceOf(body.service)
  }
}
