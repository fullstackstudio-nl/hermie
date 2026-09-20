/**
 * What the Hermie Web server tells the app about itself.
 *
 * On every other platform there is no such server, so the whole module answers
 * "not applicable" — `web-config.web.ts` is the real one.
 */

export interface HermieWebConfig {
  /** The gateway host Hermie Web proxies to, for display only. */
  gatewayHost: string
  /** The Hermie Web version serving this bundle. */
  version: string
}

/**
 * The gateway's base URL in a browser: the origin this page was served from,
 * because Hermie Web proxies the gateway onto it. `null` off the web, where the
 * user names an address instead.
 */
export const WEB_GATEWAY_BASE_URL: string | null = null

export async function loadHermieWebConfig(): Promise<HermieWebConfig | null> {
  return null
}
