/**
 * Everything Hermie Web can be told, and what it decides when it is told
 * nothing.
 *
 * One rule runs through all of it: **the gateway is fixed at startup.** There
 * is no path, header or query parameter that can point the proxy somewhere
 * else, because an HTTP proxy a browser can steer is an open proxy, and an open
 * proxy on a machine that can reach `127.0.0.1` is a way into everything else
 * running there.
 */
import { hostname } from 'node:os'
import path from 'node:path'

import { defaultStateDir } from './push/state'

export interface HermieWebOptions {
  /** The gateway to proxy to. Fixed for the life of the process. */
  gatewayUrl: string
  port: number
  host: string
  /**
   * The host the GATEWAY believes it is served on — its `dashboard.public_url`.
   *
   * Proxied requests carry this in `Host` and `Origin`, because the gateway
   * refuses an upgrade whose `Host` is not a host it knows (DNS-rebinding
   * guard) and refuses an `Origin` that does not match it either. What a
   * browser sends is Hermie Web's own address, which the gateway has never
   * heard of, so it has to be rewritten rather than forwarded.
   */
  publicUrl: string
  /** Directory holding the exported web build. */
  staticDir: string
  /** Hermie Web's own version, reported by `/healthz` and `/hermie/config.json`. */
  version: string
  /** Turn the self-update endpoints off entirely. */
  selfUpdate: boolean
  /** Where releases are unpacked and the `current` link lives. */
  installRoot: string
  /**
   * Watch every Bot Chat and notify registered devices ([ADR-0017](../../../docs/adr/0017-push-through-hermie-web.md)).
   *
   * Off by default, and deliberately a separate switch from serving the app: the
   * daemon holds a gateway connection that keeps every Bot Chat resident in the
   * gateway's live-session list, which is a real cost a self-hoster should opt
   * into rather than discover.
   */
  push: boolean
  /** The session token an ungated gateway takes. Empty on a gated one; see `hermie-web login`. */
  gatewayToken: string
  /** Where the watch state, the VAPID key pair and any stored sign-in live. */
  stateDir: string
  /**
   * The `sub` claim of the VAPID token (RFC 8292 §2.1): a `mailto:` or `https:`
   * URI a push service can use to reach whoever runs this. The default names the
   * project because it has to name something; an operator sending real volume
   * should put their own address here.
   */
  vapidSubject: string
  /**
   * Ask the gateway to route server→client requests to the push connection.
   *
   * Off by default, and it should stay off unless the operator knows their
   * gateway fans a request out to EVERY peer of a session. On one that routes
   * to a single peer, a daemon that receives an approval and holds it open —
   * which is the only thing it will ever do with one — has taken the question
   * away from the person it was for. Without it, open questions are learnt from
   * a resume's snapshot and from the `approval.pending` poll, which is what the
   * app does too.
   */
  pushServerRequests: boolean
}

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9119'
export const DEFAULT_PORT = 9120
export const DEFAULT_HOST = '127.0.0.1'
/** Named so a test can say it, and so the docs and the code cannot drift apart. */
export const DEFAULT_VAPID_SUBJECT = 'https://hermie.dev'

/**
 * Where the browser build reads the application-server key it has to subscribe
 * against. It is PUBLIC by definition — it is the half a browser is given — and
 * it authorises nothing on its own.
 */
export const PUSH_PUBLIC_KEY_PATH = '/push/vapid-public-key'

/**
 * Paths that belong to the gateway rather than to the app.
 *
 * A prefix list rather than a catch-all, so an unknown path falls through to
 * the SPA and a typo cannot silently become a proxied request. The cookie flow
 * needs all four: `/login` is the gateway's own sign-in page for password
 * providers, `/auth/*` is the whole OAuth round trip plus `password-login` and
 * `logout`, `/api/*` is the REST surface and the WebSocket, and `/logout` is
 * the shorthand some deployments link to.
 */
export const GATEWAY_PATH_PREFIXES: readonly string[] = ['/api', '/auth', '/login', '/logout']

/** Paths Hermie Web answers itself, and therefore never proxies. */
export const LOCAL_PATHS: readonly string[] = [
  '/healthz',
  '/hermie/config.json',
  '/hermie/update',
  PUSH_PUBLIC_KEY_PATH
]

export function isGatewayPath(pathname: string): boolean {
  if (LOCAL_PATHS.includes(pathname)) {
    return false
  }

  return GATEWAY_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * The origin a proxied request claims to come from.
 *
 * `https://gateway.example` for a public URL with a scheme; a bare host is
 * read as the same scheme the gateway itself is on, which is what a person
 * typing `--public-url hermes.tailnet.ts.net` means.
 */
export function normalizePublicUrl(raw: string, gatewayUrl: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return new URL(gatewayUrl).origin
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${new URL(gatewayUrl).protocol}//${trimmed}`

  return new URL(withScheme).origin
}

export interface ResolveOptionsInput {
  gatewayUrl?: string | undefined
  port?: string | number | undefined
  host?: string | undefined
  publicUrl?: string | undefined
  staticDir?: string | undefined
  version?: string | undefined
  selfUpdate?: boolean | undefined
  installRoot?: string | undefined
  push?: boolean | undefined
  gatewayToken?: string | undefined
  stateDir?: string | undefined
  vapidSubject?: string | undefined
  pushServerRequests?: boolean | undefined
  env?: NodeJS.ProcessEnv
  /** Where `dist/web` sits when `--static` is not given. */
  packageRoot?: string
}

/** Flags beat environment variables beat defaults, in that order. */
export function resolveOptions(input: ResolveOptionsInput = {}): HermieWebOptions {
  const env = input.env ?? process.env
  const packageRoot = input.packageRoot ?? path.resolve(__dirname, '..', '..')
  const gatewayUrl = new URL(input.gatewayUrl ?? env.HERMIE_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).toString()
  const rawPort = input.port ?? env.HERMIE_PORT ?? DEFAULT_PORT
  const port = typeof rawPort === 'number' ? rawPort : Number.parseInt(rawPort, 10)

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be a number between 0 and 65535 (got ${String(rawPort)}).`)
  }

  const selfUpdate =
    input.selfUpdate ?? (env.HERMIE_SELF_UPDATE === '0' || env.HERMIE_SELF_UPDATE === 'false' ? false : true)

  return {
    gatewayUrl,
    port,
    host: input.host ?? env.HERMIE_HOST ?? DEFAULT_HOST,
    publicUrl: normalizePublicUrl(input.publicUrl ?? env.HERMIE_PUBLIC_URL ?? '', gatewayUrl),
    staticDir: path.resolve(input.staticDir ?? env.HERMIE_STATIC_DIR ?? path.join(packageRoot, 'dist', 'web')),
    version: input.version ?? env.HERMIE_VERSION ?? readOwnVersion(packageRoot),
    selfUpdate,
    installRoot: path.resolve(input.installRoot ?? env.HERMIE_INSTALL_ROOT ?? path.join(packageRoot, '..')),
    push: input.push ?? (env.HERMIE_PUSH === '1' || env.HERMIE_PUSH === 'true'),
    gatewayToken: input.gatewayToken ?? env.HERMIE_GATEWAY_TOKEN ?? '',
    // NOT the install root: a self-update replaces that, and a daemon that
    // forgot its VAPID key after an update would orphan every browser
    // subscription it had ever handed out.
    stateDir: path.resolve(input.stateDir ?? defaultStateDir(env)),
    vapidSubject: input.vapidSubject ?? env.HERMIE_VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT,
    pushServerRequests:
      input.pushServerRequests ??
      (env.HERMIE_PUSH_SERVER_REQUESTS === '1' || env.HERMIE_PUSH_SERVER_REQUESTS === 'true')
  }
}

function readOwnVersion(packageRoot: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require(path.join(packageRoot, 'package.json')) as { version?: string }

    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** A short, honest name for the machine, used only in log lines. */
export function describeHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? `${hostname()} (all interfaces)` : host
}
