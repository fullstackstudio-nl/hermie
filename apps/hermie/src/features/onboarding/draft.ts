import {
  type AuthProvider,
  type GatewayAuthMode,
  normalizeHeader,
  type ProbeResult,
  type TokenSet
} from '@hermie/gateway-client'

import type { StoredGatewayConfig } from '../../gateway/config'
import { RUNS_IN_BROWSER } from '../../platform/runs-in-browser'

/**
 * Everything the wizard has learned so far, held in memory only. Nothing here
 * reaches the secret store until the last step, so closing the app halfway
 * through leaves no credential behind.
 */

export type OnboardingStep = 'welcome' | 'address' | 'signin' | 'test' | 'done'

/**
 * The wizard's order, which is one step shorter in a browser.
 *
 * Hermie Web serves the app and proxies the gateway onto the SAME origin, so
 * the gateway address is not a question — it is `window.location.origin`, and
 * any other answer would be wrong. Asking for it would be asking the user to
 * retype the address bar. The server's own host is shown instead, read from
 * `/hermie/config.json`.
 */
export const ONBOARDING_ORDER: OnboardingStep[] = RUNS_IN_BROWSER
  ? ['welcome', 'signin', 'test', 'done']
  : ['welcome', 'address', 'signin', 'test', 'done']

/** The steps that carry a "step N of M" counter; Welcome is the cover, not a step. */
export const NUMBERED_STEPS: OnboardingStep[] = ONBOARDING_ORDER.filter(step => step !== 'welcome')

export interface HeaderRow {
  /** Stable across edits so a re-render cannot move the focus to another row. */
  id: string
  name: string
  value: string
}

export interface ConnectionTestOutcome {
  /** The payload this result was produced for; a mismatch means "test again". */
  key: string
  userDisplayName: string
  botCount: number
  /**
   * The token set as it stands AFTER the test.
   *
   * The test dials for real, and a dial refreshes an access token that is
   * inside its skew window — which rotates the refresh token with it. The
   * gateway then invalidates the old one, so saving the draft's original pair
   * writes a credential that is already dead and the first reconnect lands on
   * the sign-in screen.
   */
  tokens?: TokenSet | null
}

/** Who the gateway says we are, once a cookie session has been established. */
export interface CookieIdentity {
  userId: string
  displayName: string
}

export interface OnboardingDraft {
  /** Exactly what the user typed, before coercion. */
  rawAddress: string
  /** The normalized address, set only once a probe has succeeded against it. */
  baseUrl: string | null
  headers: HeaderRow[]
  probe: ProbeResult | null
  provider: AuthProvider | null
  tokens: TokenSet | null
  sessionToken: string
  /**
   * Set once `GET /api/auth/me` has confirmed the gateway's session cookie.
   *
   * There is no credential to hold in the browser flow — the cookie is
   * `HttpOnly` and belongs to the gateway — so "are we signed in" is a fact the
   * server states rather than a token the wizard carries.
   */
  cookieIdentity: CookieIdentity | null
  test: ConnectionTestOutcome | null
}

let headerSeq = 0

export function newHeaderRow(name = '', value = ''): HeaderRow {
  headerSeq += 1

  return { id: `header-${headerSeq}`, name, value }
}

export function emptyDraft(): OnboardingDraft {
  return {
    rawAddress: '',
    baseUrl: null,
    headers: [],
    probe: null,
    provider: null,
    tokens: null,
    sessionToken: '',
    cookieIdentity: null,
    test: null
  }
}

/**
 * Resume after a sign-out. The address and the provider survive in the
 * key-value store, so the wizard can open straight on the sign-in step; the
 * probe still has to run, because whether the gateway is gated today is not
 * something an old preference file can promise.
 */
export function draftFromConfig(config: StoredGatewayConfig): OnboardingDraft {
  return {
    ...emptyDraft(),
    rawAddress: config.baseUrl,
    baseUrl: config.baseUrl,
    provider: config.provider
      ? { name: config.provider, displayName: config.providerDisplayName ?? config.provider, supportsPassword: false }
      : null,
    probe: {
      version: config.version ?? '',
      authRequired: config.authMode !== 'session_token',
      authFlows: config.authMode === 'session_token' ? [] : [config.authMode],
      providers: config.provider
        ? [
            {
              name: config.provider,
              displayName: config.providerDisplayName ?? config.provider,
              supportsPassword: false
            }
          ]
        : [],
      supportsNativePkce: config.authMode === 'native_pkce'
    }
  }
}

/**
 * A gated gateway signs in; an ungated one authenticates with its session token.
 *
 * In a browser a gated gateway means the COOKIE flow, not the native one: a
 * page cannot listen on a loopback port for an RFC 8252 redirect, and it does
 * not have to — the gateway already has a browser session flow, and Hermie Web
 * puts the app on the origin that flow's cookies belong to. `cookie` is only
 * chosen when the gateway advertises it, so an old gateway that only knows
 * `native_pkce` still reports the mode the sign-in step will refuse out loud
 * rather than a mode nothing can complete.
 */
export function authModeOf(probe: ProbeResult | null): GatewayAuthMode {
  if (!probe?.authRequired) {
    return 'session_token'
  }

  return RUNS_IN_BROWSER && probe.authFlows.includes('cookie') ? 'cookie' : 'native_pkce'
}

export function headerError(row: HeaderRow): string | null {
  if (!row.name.trim()) {
    return null
  }

  try {
    normalizeHeader(row.name, row.value)

    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The extra headers as the transport wants them: named rows only, CR and LF
 * stripped by `normalizeHeader`, and sorted so the same set of rows always
 * produces the same payload key regardless of the order they were typed in.
 */
export function headerRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {}

  for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!row.name.trim()) {
      continue
    }

    try {
      const [name, value] = normalizeHeader(row.name, row.value)
      out[name] = value
    } catch {
      // Invalid rows are reported inline next to the field; they simply do not
      // travel.
    }
  }

  return out
}

/**
 * Identity of everything a connection test actually exercised. The test result
 * carries the key it was produced for, so editing any field — the address, a
 * header, the token, the provider — invalidates the result without anyone
 * having to remember to clear it.
 */
export function connectionPayloadKey(draft: OnboardingDraft): string {
  return JSON.stringify({
    baseUrl: draft.baseUrl ?? '',
    headers: headerRecord(draft.headers),
    authMode: authModeOf(draft.probe),
    provider: draft.provider?.name ?? '',
    credential: draft.tokens?.accessToken ?? draft.cookieIdentity?.userId ?? draft.sessionToken.trim()
  })
}

/** True when the draft holds a credential the gateway could actually be tested with. */
export function hasCredential(draft: OnboardingDraft): boolean {
  switch (authModeOf(draft.probe)) {
    case 'session_token':
      return draft.sessionToken.trim().length > 0
    case 'cookie':
      return draft.cookieIdentity !== null
    case 'native_pkce':
      return draft.tokens !== null
  }
}

/** True when the current draft is exactly what the last successful test ran against. */
export function isTestCurrent(draft: OnboardingDraft): boolean {
  return draft.test !== null && draft.test.key === connectionPayloadKey(draft)
}

/** The non-secret half, as it will be written to the key-value store. */
export function configFromDraft(draft: OnboardingDraft): StoredGatewayConfig {
  const authMode = authModeOf(draft.probe)

  return {
    baseUrl: draft.baseUrl ?? '',
    authMode,
    ...(authMode !== 'session_token' && draft.provider
      ? { provider: draft.provider.name, providerDisplayName: draft.provider.displayName }
      : {}),
    ...(draft.probe?.version ? { version: draft.probe.version } : {}),
    ...(draft.test?.userDisplayName ? { userDisplayName: draft.test.userDisplayName } : {})
  }
}
