import {
  type FrontDoor,
  frontDoorHeaders,
  type GatewayAuthMode,
  NO_FRONT_DOOR,
  originOf,
  type TokenSet
} from '@hermie/gateway-client'

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

/**
 * Secret-store keys. Signing out deletes exactly these six.
 *
 * `frontDoor` is a secret and not configuration, even though half of it — a
 * Cloudflare Access client id — is not itself one. The pair is entered together,
 * is useless apart, and a record split across two stores is a record that goes
 * out of step; the keychain is also what the origin binding below is worth
 * having in front of.
 */
export const SECRET_KEYS = {
  accessToken: 'hermie.auth.access_token',
  refreshToken: 'hermie.auth.refresh_token',
  tokenMeta: 'hermie.auth.token_meta',
  sessionToken: 'hermie.auth.session_token',
  extraHeaders: 'hermie.auth.extra_headers',
  frontDoor: 'hermie.auth.front_door'
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
  /**
   * What actually goes on the wire: the headers typed under "Custom headers"
   * with the front door's own pair folded in on top.
   *
   * One map rather than two, because everything downstream — the REST client,
   * the dial plan, the probe — takes exactly one and has no business knowing
   * which preset produced it. Which preset DID produce it is `frontDoor`, and
   * that is only read by the surfaces that have to show it back.
   */
  extraHeaders: Record<string, string>
  /** The headers as typed, so the wizard can show them again after a sign-out. */
  customHeaders: Record<string, string>
  /** The preset, or `{ kind: 'none' }` — including when one was dropped for the wrong origin. */
  frontDoor: FrontDoor
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
  /** The headers as typed under "Custom headers". The front door adds its own. */
  extraHeaders: Record<string, string>
  frontDoor?: FrontDoor
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

/**
 * Read a stored front door back, and refuse one that belongs to another gateway.
 *
 * A Cloudflare Access service token is issued for one Access application, which
 * is one hostname. A record that survived a change of gateway would be sent to
 * a host that never asked for it and cannot use it — a long-lived tenant
 * credential handed to a stranger, in exchange for nothing. So the origin it
 * was entered for rides along with it and a mismatch drops the whole record
 * rather than trying to repair it.
 *
 * "Change gateway" already clears the credentials when the address changes, so
 * this is the second line rather than the first. It is the line that holds when
 * the address changed some other way: an edited config, a restore onto another
 * device, a build that wrote the record before the origin was part of it — and
 * that last case is exactly why an absent `origin` reads as a mismatch rather
 * than as permission.
 */
function readFrontDoor(raw: string | null, baseUrl: string): FrontDoor {
  if (!raw) {
    return NO_FRONT_DOOR
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return NO_FRONT_DOOR
    }

    const record = parsed as Record<string, unknown>

    if (
      record.kind !== 'cloudflare_access' ||
      typeof record.clientId !== 'string' ||
      typeof record.clientSecret !== 'string' ||
      typeof record.origin !== 'string'
    ) {
      return NO_FRONT_DOOR
    }

    if (record.origin.toLowerCase() !== originOf(baseUrl)) {
      return NO_FRONT_DOOR
    }

    return {
      kind: 'cloudflare_access',
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      origin: record.origin.toLowerCase()
    }
  } catch {
    // A record written by an older build is not worth failing a launch over.
    // The connection goes out without it and the resulting 403 explains itself.
    return NO_FRONT_DOOR
  }
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
  const [rawHeaders, rawFrontDoor, sessionToken, accessToken, refreshToken] = await Promise.all([
    secretStore.get(SECRET_KEYS.extraHeaders),
    secretStore.get(SECRET_KEYS.frontDoor),
    secretStore.get(SECRET_KEYS.sessionToken),
    secretStore.get(SECRET_KEYS.accessToken),
    secretStore.get(SECRET_KEYS.refreshToken)
  ]).catch((error: unknown) => {
    credentialError = error instanceof Error ? error.message : String(error)

    return [null, null, null, null, null] as const
  })

  let customHeaders: Record<string, string> = {}

  if (rawHeaders) {
    try {
      const parsed: unknown = JSON.parse(rawHeaders)

      if (isRecordOfStrings(parsed)) {
        customHeaders = parsed
      }
    } catch {
      // A header blob written by an older build is not worth failing startup
      // over; the connection simply goes out without the extra headers, and
      // the resulting 403 explains itself.
    }
  }

  const frontDoor = readFrontDoor(rawFrontDoor, config.baseUrl)
  // The front door goes on LAST, so a hand-typed `CF-Access-Client-Secret`
  // under Custom headers cannot quietly shadow the one the preset holds.
  const extraHeaders = { ...customHeaders, ...frontDoorHeaders(frontDoor, config.baseUrl) }

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
    customHeaders,
    frontDoor,
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
  const { config, extraHeaders, frontDoor = NO_FRONT_DOOR, tokens, sessionToken } = input

  await keyValueStore.setJson(CONFIG_KEY, config)

  const writes: Promise<void>[] = [
    Object.keys(extraHeaders).length > 0
      ? secretStore.set(SECRET_KEYS.extraHeaders, JSON.stringify(extraHeaders))
      : secretStore.delete(SECRET_KEYS.extraHeaders),
    // Bound to the address being saved rather than to whatever the record said
    // when it was typed, so the two cannot disagree after a change of gateway.
    frontDoor.kind === 'cloudflare_access'
      ? secretStore.set(SECRET_KEYS.frontDoor, JSON.stringify({ ...frontDoor, origin: originOf(config.baseUrl) }))
      : secretStore.delete(SECRET_KEYS.frontDoor)
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
