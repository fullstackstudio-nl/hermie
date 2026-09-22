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

import { DEFAULT_CACHE_MAX_MB } from './cache'
import { defaultStateDir } from './push/state'

export interface HermieWebOptions {
  /** The gateway to proxy to. Fixed for the life of the process. */
  gatewayUrl: string
  /**
   * Did anybody actually CHOOSE that gateway?
   *
   * `gatewayUrl` always has a value, because the default is the port
   * `hermes serve` listens on — which is right often enough to be the default
   * and is still a guess. This is the difference between the guess and a
   * decision: a flag, an environment variable, or a setup an operator saved
   * through `/setup`.
   *
   * It decides one thing only: whether the operator setup page of
   * [ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md) is
   * served or answers 404. The gateway is still fixed at process start — there
   * is one transition, from unconfigured to configured, and no route back.
   */
  gatewayConfigured: boolean
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
  /**
   * The path the gateway sends the browser to once a sign-in finishes.
   *
   * The app puts it in `next=` on `/auth/login`, and the gateway hands it back
   * as a RELATIVE redirect from `/auth/callback` — which is on
   * `dashboard.public_url`, not here. So on a deployment where Hermie Web sits
   * on a different port of that same host, the browser lands on the gateway
   * rather than on the app, and this is the path an operator points back at
   * Hermie Web (a redirect in the reverse proxy; `deploy/web/README.md` has the
   * worked example). `/` is right whenever the two share an origin.
   */
  loginReturn: string

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
   * How much disk the message cache may take, in megabytes
   * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   *
   * `0` turns it off, and turning it off is a real option rather than a
   * degenerate one: the cache holds transcript CONTENT, which is the first
   * thing this process has ever stored that is not a credential. An operator
   * who would rather every chat opened cold than have Bot Chat tails on the
   * service's disk says so here.
   */
  cacheMaxMb: number
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
  /**
   * Let the built-in OIDC provider be enabled on an origin that is not https.
   *
   * It exists to be REFUSED by default rather than to be used. The gateway's
   * own relying party rejects an issuer that is not `https` — or `http` on
   * `localhost`, `127.0.0.1` or `::1`, which it allows by name and which
   * therefore needs no flag at all. So this only unlocks the one case upstream
   * will not accept: plain http on a real hostname. An operator who passes it
   * gets a provider a browser can use and the gateway will not, which is why
   * `/admin` says so beside the switch rather than letting it be discovered
   * later ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   */
  allowInsecureOidc: boolean
}

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:9119'
export const DEFAULT_PORT = 9120
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_LOGIN_RETURN = '/'
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

/**
 * Is this a path on our own origin, and nothing else?
 *
 * Everything that is not one is a way to send a signed-in browser somewhere
 * else: `https://evil.example` is obvious, `//evil.example` is a
 * protocol-relative URL that reads as a host, and `/\evil.example` is the same
 * trick for the browsers that normalise a backslash into a slash. Control
 * characters are refused because a header cannot carry them and something
 * downstream would have to decide what to do with them.
 *
 * The gateway validates `next=` again on arrival, which is the check that
 * actually protects the session. This one exists so a mistake in a unit file is
 * a startup failure with a name on it rather than a redirect that works.
 */
export function isSameOriginPath(raw: string): boolean {
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return false
  }

  // eslint-disable-next-line no-control-regex
  return !/[\s\\]|[\u0000-\u001f\u007f]/.test(raw)
}

/** `--login-return`, checked. Empty means the default; anything unsafe throws. */
export function normalizeLoginReturn(raw: string): string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return DEFAULT_LOGIN_RETURN
  }

  if (!isSameOriginPath(trimmed)) {
    throw new Error(`--login-return must be a path on this origin, starting with a single "/" (got ${raw}).`)
  }

  return trimmed
}

export interface ResolveOptionsInput {
  gatewayUrl?: string | undefined
  /** Overrides the "was it chosen or defaulted" reading; `startHermieWeb` sets it from the saved setup. */
  gatewayConfigured?: boolean | undefined
  port?: string | number | undefined
  host?: string | undefined
  publicUrl?: string | undefined
  staticDir?: string | undefined
  loginReturn?: string | undefined
  version?: string | undefined
  selfUpdate?: boolean | undefined
  installRoot?: string | undefined
  push?: boolean | undefined
  gatewayToken?: string | undefined
  stateDir?: string | undefined
  cacheMaxMb?: string | number | undefined
  vapidSubject?: string | undefined
  pushServerRequests?: boolean | undefined
  allowInsecureOidc?: boolean | undefined
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
    // A flag or an environment variable is a decision; the default is not. A
    // caller that has read a saved setup says so outright.
    gatewayConfigured: input.gatewayConfigured ?? (input.gatewayUrl ?? env.HERMIE_GATEWAY_URL) !== undefined,
    port,
    host: input.host ?? env.HERMIE_HOST ?? DEFAULT_HOST,
    publicUrl: normalizePublicUrl(input.publicUrl ?? env.HERMIE_PUBLIC_URL ?? '', gatewayUrl),
    staticDir: path.resolve(input.staticDir ?? env.HERMIE_STATIC_DIR ?? path.join(packageRoot, 'dist', 'web')),
    loginReturn: normalizeLoginReturn(input.loginReturn ?? env.HERMIE_LOGIN_RETURN ?? DEFAULT_LOGIN_RETURN),
    version: input.version ?? env.HERMIE_VERSION ?? readOwnVersion(packageRoot),
    selfUpdate,
    installRoot: path.resolve(input.installRoot ?? env.HERMIE_INSTALL_ROOT ?? path.join(packageRoot, '..')),
    push: input.push ?? (env.HERMIE_PUSH === '1' || env.HERMIE_PUSH === 'true'),
    gatewayToken: input.gatewayToken ?? env.HERMIE_GATEWAY_TOKEN ?? '',
    // NOT the install root: a self-update replaces that, and a daemon that
    // forgot its VAPID key after an update would orphan every browser
    // subscription it had ever handed out.
    stateDir: path.resolve(input.stateDir ?? defaultStateDir(env)),
    cacheMaxMb: readCacheMaxMb(input.cacheMaxMb ?? env.HERMIE_CACHE_MAX_MB),
    vapidSubject: input.vapidSubject ?? env.HERMIE_VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT,
    pushServerRequests:
      input.pushServerRequests ??
      (env.HERMIE_PUSH_SERVER_REQUESTS === '1' || env.HERMIE_PUSH_SERVER_REQUESTS === 'true'),
    allowInsecureOidc:
      input.allowInsecureOidc ?? (env.HERMIE_ALLOW_INSECURE_OIDC === '1' || env.HERMIE_ALLOW_INSECURE_OIDC === 'true')
  }
}

/**
 * `--cache-max-mb`, checked.
 *
 * A typo here would either turn the cache off in silence or hand an eviction
 * loop a `NaN` to compare against, so anything that is not a number is a
 * startup failure with the value in it. `0` is legal and means off.
 */
function readCacheMaxMb(raw: string | number | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_CACHE_MAX_MB
  }

  const value = typeof raw === 'number' ? raw : Number.parseFloat(raw)

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--cache-max-mb must be a number of megabytes, 0 or more (got ${String(raw)}).`)
  }

  return value
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
