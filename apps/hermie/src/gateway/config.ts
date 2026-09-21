import type { GatewayAuthMode, TokenSet } from '@hermie/gateway-client'

import { keyValueStore } from '../platform/key-value-store'
import { secretStore } from '../platform/secret-store'
import { clearUrlCache } from '../platform/url-cache'

/**
 * Where a configured gateway lives on disk.
 *
 * The split is deliberate and follows what each store is for: the secret store
 * is a keychain item, so only credentials go there, and the key-value store is
 * a plain preference file, so it holds the things you would happily print in a
 * support log — which address, which provider, which version.
 */

/** Non-secret configuration, in the key-value store. */
export const CONFIG_KEY = 'hermie.gateway.config'

/** Secret-store keys. Signing out deletes exactly these five. */
export const SECRET_KEYS = {
  accessToken: 'hermie.auth.access_token',
  refreshToken: 'hermie.auth.refresh_token',
  tokenMeta: 'hermie.auth.token_meta',
  sessionToken: 'hermie.auth.session_token',
  extraHeaders: 'hermie.auth.extra_headers'
} as const

export interface StoredGatewayConfig {
  baseUrl: string
  authMode: GatewayAuthMode
  /** Provider name as the gateway reports it, e.g. `self-hosted`. */
  provider?: string
  /** Provider label for the UI, e.g. `Self-Hosted OIDC`. */
  providerDisplayName?: string
  version?: string
  userDisplayName?: string
}

export interface GatewaySetup {
  config: StoredGatewayConfig
  extraHeaders: Record<string, string>
  sessionToken: string | null
  /** False after a sign-out: the address is known, the credentials are not. */
  hasCredentials: boolean
  /**
   * Whether the stored credential can outlive its access token.
   *
   * Read off the secret store rather than remembered as a flag, because it is a
   * fact about what is actually there: a provider whose client has no
   * `offline_access` scope answers the exchange without a refresh token, and
   * the session then ends silently when the access token expires. Only
   * meaningful for `native_pkce` — the other two modes have nothing to rotate
   * and answer true so nothing warns about them.
   */
  canRefresh: boolean
  /**
   * Set when the secret store REFUSED rather than came back empty.
   *
   * The two are indistinguishable downstream — `expo-secure-store` resolves a
   * missing item and an item in an unreadable access group to the same `null` —
   * so the difference has to be captured at the one place where it still
   * exists, which is here. Without it, a launch that lands on the sign-in step
   * leaves nothing behind saying whether the credential was gone or merely out
   * of reach.
   */
  credentialError?: string
}

export interface SaveGatewaySetupInput {
  config: StoredGatewayConfig
  extraHeaders: Record<string, string>
  /** Native PKCE only. */
  tokens?: TokenSet | null
  /** Session-token gateways only. */
  sessionToken?: string | null
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
  )
}

/** Read the configured gateway, or `null` when the app has never been set up. */
export async function loadGatewaySetup(): Promise<GatewaySetup | null> {
  const config = await keyValueStore.getJson<StoredGatewayConfig>(CONFIG_KEY)

  if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
    return null
  }

  let credentialError: string | undefined

  // A throwing keychain must not strand the launch. Before this, the rejection
  // escaped `reload()`'s un-awaited call and the app sat on the splash for ever
  // — the one outcome worse than asking for a sign-in.
  const [rawHeaders, sessionToken, accessToken, refreshToken] = await Promise.all([
    secretStore.get(SECRET_KEYS.extraHeaders),
    secretStore.get(SECRET_KEYS.sessionToken),
    secretStore.get(SECRET_KEYS.accessToken),
    secretStore.get(SECRET_KEYS.refreshToken)
  ]).catch((error: unknown) => {
    credentialError = error instanceof Error ? error.message : String(error)

    return [null, null, null, null] as const
  })

  let extraHeaders: Record<string, string> = {}

  if (rawHeaders) {
    try {
      const parsed: unknown = JSON.parse(rawHeaders)

      if (isRecordOfStrings(parsed)) {
        extraHeaders = parsed
      }
    } catch {
      // A header blob written by an older build is not worth failing startup
      // over; the connection simply goes out without the extra headers, and
      // the resulting 403 explains itself.
    }
  }

  /**
   * Is there a credential to reconnect with?
   *
   * The cookie flow is the odd one out and deliberately answers TRUE without
   * looking: its credential is an `HttpOnly` cookie in the browser's own jar,
   * which this process cannot read by design. The only honest way to find out
   * whether it is still good is to use it — so the app dials, and a lapsed
   * session comes back as `needs_signin` from the gateway, which is the same
   * answer with a real reason attached. Answering false here instead would send
   * every reload of a perfectly signed-in tab back to the wizard.
   */
  const hasCredentials =
    config.authMode === 'cookie'
      ? true
      : config.authMode === 'session_token'
        ? Boolean(sessionToken)
        : Boolean(accessToken)

  // Only the PKCE flow has anything to rotate; the other two say yes so that
  // nothing downstream warns a session-token or cookie gateway about a refresh
  // token it was never going to have.
  const canRefresh = config.authMode === 'native_pkce' ? Boolean(refreshToken) : true

  return {
    config,
    extraHeaders,
    sessionToken,
    hasCredentials,
    canRefresh,
    ...(credentialError ? { credentialError } : {})
  }
}

/**
 * Write everything the app needs to reconnect on its next launch. This is the
 * only point in onboarding where a secret is persisted: up to here the tokens
 * exist only in memory, so abandoning a half-finished wizard leaves nothing
 * behind.
 */
export async function saveGatewaySetup(input: SaveGatewaySetupInput): Promise<void> {
  const { config, extraHeaders, tokens, sessionToken } = input

  await keyValueStore.setJson(CONFIG_KEY, config)

  const writes: Promise<void>[] = [
    Object.keys(extraHeaders).length > 0
      ? secretStore.set(SECRET_KEYS.extraHeaders, JSON.stringify(extraHeaders))
      : secretStore.delete(SECRET_KEYS.extraHeaders)
  ]

  if (tokens) {
    writes.push(
      secretStore.set(SECRET_KEYS.accessToken, tokens.accessToken),
      secretStore.set(SECRET_KEYS.refreshToken, tokens.refreshToken),
      secretStore.set(
        SECRET_KEYS.tokenMeta,
        JSON.stringify({ expiresAt: tokens.expiresAt, provider: tokens.provider, userId: tokens.userId })
      )
    )
  }

  if (sessionToken) {
    writes.push(secretStore.set(SECRET_KEYS.sessionToken, sessionToken))
  }

  await Promise.all(writes)
}

/** Sign out: forget the credentials, keep the address. */
export async function clearCredentials(): Promise<void> {
  await Promise.all(Object.values(SECRET_KEYS).map(key => secretStore.delete(key)))
}

/** Change gateway: forget the credentials and the address. */
export async function clearGateway(): Promise<void> {
  await clearCredentials()
  await keyValueStore.delete(CONFIG_KEY)
  /*
    And whatever the platform cached for it.

    `URLCache` is keyed by bundle identifier and survives the app being deleted,
    so a 301 stored when a gateway moved domains was still being served to a
    fresh install months later — the probe reached the old host and the failure
    named the address the owner had correctly typed. Forgetting a gateway is the
    one moment where nothing cached for it is wanted any more, and it is the
    only moment the app has any business emptying a cache at all.
  */
  clearUrlCache()
}
