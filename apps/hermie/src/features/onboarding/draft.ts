import {
  type AuthProvider,
  type GatewayAuthMode,
  normalizeHeader,
  type ProbeResult,
  type TokenSet
} from '@hermie/gateway-client'

import type { StoredGatewayConfig } from '../../gateway/config'

/**
 * Everything the wizard has learned so far, held in memory only. Nothing here
 * reaches the secret store until the last step, so closing the app halfway
 * through leaves no credential behind.
 */

export type OnboardingStep = 'welcome' | 'address' | 'signin' | 'test' | 'done'

/** The steps that carry a "step N of M" counter; Welcome is the cover, not a step. */
export const NUMBERED_STEPS: OnboardingStep[] = ['address', 'signin', 'test', 'done']

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
      authRequired: config.authMode === 'native_pkce',
      authFlows: config.authMode === 'native_pkce' ? ['native_pkce'] : [],
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

/** A gated gateway signs in; an ungated one authenticates with its session token. */
export function authModeOf(probe: ProbeResult | null): GatewayAuthMode {
  return probe?.authRequired ? 'native_pkce' : 'session_token'
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
    credential: draft.tokens?.accessToken ?? draft.sessionToken.trim()
  })
}

/** True when the draft holds a credential the gateway could actually be tested with. */
export function hasCredential(draft: OnboardingDraft): boolean {
  return authModeOf(draft.probe) === 'session_token' ? draft.sessionToken.trim().length > 0 : draft.tokens !== null
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
    ...(authMode === 'native_pkce' && draft.provider
      ? { provider: draft.provider.name, providerDisplayName: draft.provider.displayName }
      : {}),
    ...(draft.probe?.version ? { version: draft.probe.version } : {}),
    ...(draft.test?.userDisplayName ? { userDisplayName: draft.test.userDisplayName } : {})
  }
}
