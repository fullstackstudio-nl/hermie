/**
 * What the Hermie Web server tells the app about itself.
 *
 * On every other platform there is no such server, so the whole module answers
 * "not applicable" — `web-config.web.ts` is the real one.
 */
import type { AuthProvider, ProbeResult } from '@hermie/gateway-client'

/** What Hermie Web reports about its own long-lived gateway link. */
export interface HermieWebService {
  /** A service sign-in is stored, so push and the message cache have a credential. */
  login: boolean
  /** The push daemon is running. */
  push: boolean
  /** The message cache is on. */
  cache: boolean
}

/**
 * What a team's Hermie Web wants its build to look like (ADR-0025, part 2).
 *
 * Every field is optional and an ABSENT one means "the app decides", which is
 * not the same answer as an empty string. A reader who has already chosen a
 * theme or an accent keeps it: this is where the app starts, never an override,
 * because an operator's default that reached back in and undid somebody's
 * choice would be a setting that fights its own reader.
 */
export interface HermieWebBranding {
  /** Shown instead of "Hermie" where the app names itself. */
  name?: string
  /** One of the app's accent names. */
  accent?: string
  /** A theme preset name the app starts on. */
  theme?: string
}

/** Service features an operator turned off for everybody on this deployment. */
export interface HermieWebFlags {
  /** ADR-0007's amendment: the private chat beside the shared Bot Chat. */
  userChats: boolean
  /** Whether the service will serve its message cache to this app at all. */
  messageCache: boolean
  /** Whether Settings may offer the update button. */
  selfUpdate: boolean
}

export interface HermieWebConfig {
  /** The gateway host Hermie Web proxies to, for display only. */
  gatewayHost: string
  /** The same host with its scheme, which is what a label naming an origin wants. */
  gatewayOrigin: string
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
  /**
   * No gateway has been chosen server-side yet, so `/setup` is open and this
   * app has nothing to talk to.
   */
  setupRequired: boolean
  /**
   * What the gateway takes, as the SERVER read it — or `null` when it could not
   * be read.
   *
   * The distinction is the whole point of the field. `[]` is a gateway that
   * asks for nothing; `null` is "we do not know", and only `null` makes the app
   * probe the gateway itself.
   * [ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md): with
   * this in hand the browser build skips the address step AND the probe, and
   * opens on the sign-in step.
   */
  authKinds: string[] | null
  authRequired: boolean | null
  providers: AuthProvider[] | null
  service: HermieWebService
  /** Absent on a service that has set none, and on every older one. */
  branding: HermieWebBranding | null
  /**
   * Absent on a Hermie Web too old to send them, which reads as "every feature
   * this build has". A flag nobody set is on; a build that has never heard of
   * a flag is unaffected by it.
   */
  flags: HermieWebFlags | null
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

/**
 * The server's bootstrap read as a probe result, or `null` when it does not
 * carry one.
 *
 * It lives here rather than in the web seam so the shape is written once and
 * both halves compile against it. `supportsNativePkce` is reported honestly
 * even though a browser cannot complete that flow — the sign-in step is the
 * thing that refuses it, and it refuses it by name.
 */
export function probeFromWebConfig(config: HermieWebConfig | null): ProbeResult | null {
  if (!config || config.authKinds === null || config.authRequired === null) {
    return null
  }

  return {
    version: '',
    authRequired: config.authRequired,
    authFlows: config.authKinds,
    providers: config.providers ?? [],
    supportsNativePkce: config.authKinds.includes('native_pkce')
  }
}
