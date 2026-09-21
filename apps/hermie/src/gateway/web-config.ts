/**
 * What the Hermie Web server tells the app about itself.
 *
 * On every other platform there is no such server, so the whole module answers
 * "not applicable" — `web-config.web.ts` is the real one.
 */

export interface HermieWebConfig {
  /** The gateway host Hermie Web proxies to, for display only. */
  gatewayHost: string
  /**
   * Where a finished sign-in should put the browser: the `next=` the app hands
   * `/auth/login`.
   *
   * It is the server's to decide because only the server knows the deployment.
   * The gateway's OAuth callback is fixed to its own `dashboard.public_url`, so
   * on an install where Hermie Web answers on another PORT of that host, the
   * redirect at the end of the chain lands on the gateway and not here; the
   * operator points a path there back at Hermie Web and names that path with
   * `--login-return`. `/` on every deployment that shares one origin.
   */
  loginReturn: string
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
