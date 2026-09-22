/**
 * Hermie Web: one small process next to `hermes serve`, on its own port.
 *
 * It does two things and refuses a third. It serves the browser build of the
 * app, and it proxies exactly one gateway onto the same origin — which is the
 * whole point, because the gateway's session is an `HttpOnly` cookie and a
 * cookie belongs to an origin. The third thing, proxying anywhere the caller
 * names, is what would make this an open relay onto the operator's loopback
 * interface, so the gateway is fixed at startup and there is no code path that
 * changes it.
 *
 * Routing, in the order it is decided:
 *
 *  1. `/healthz`, `/hermie/config.json`, `/hermie/update` — answered here.
 *  2. `/setup` and `/hermie/setup/*` — answered here while no gateway is
 *     configured, and 404 for ever once one is
 *     ([ADR-0024](../../../docs/adr/0024-hermie-web-is-a-service-layer.md)).
 *  3. `/api/*`, `/auth/*`, `/login*`, `/logout*` — proxied to the gateway.
 *  4. Anything that names a file in the static build — served from disk.
 *  5. Everything else — `index.html`, so a deep link into the SPA works.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  cacheDir,
  isCapturableAnswer,
  MAX_CAPTURE_BYTES,
  rowsOfMessagesBody,
  sessionIdOfMessagesPath,
  TranscriptCache
} from './cache'
import {
  type HermieWebOptions,
  isGatewayPath,
  PUSH_PUBLIC_KEY_PATH,
  resolveOptions,
  type ResolveOptionsInput
} from './options'
import { type PushDaemon, startPushDaemon } from './push/daemon'
import { buildAuthorizeUrl, createPkce, exchangeCode, type Pkce } from './push/login'
import { sameGateway } from './push/credentials'
import { loadPushState, savePushState } from './push/state'
import { proxyHttp, type ProxyObserver, proxyUpgrade } from './proxy'
import {
  normalizeGatewayInput,
  ownOrigin,
  probeGateway,
  readSetup,
  SETUP_CALLBACK_PATH,
  setupCallbackPage,
  setupPage,
  type SetupProbe,
  writeSetup
} from './setup'
import { serveIndex, serveStatic } from './static-files'
import {
  applyUpdate,
  detectInstallShape,
  hasGatewaySession,
  isSupervised,
  ReleaseCache,
  restartProcess,
  statusFrom
} from './update'

export interface HermieWebServer {
  url: string
  port: number
  options: HermieWebOptions
  /** The push daemon, when `--push` asked for one. */
  push: PushDaemon | null
  /** The message cache. Always present; `enabled` is false at `--cache-max-mb 0`. */
  cache: TranscriptCache
  close(): Promise<void>
}

export interface StartOptions extends ResolveOptionsInput {
  /** Injected by the tests so they never reach GitHub. */
  releaseCache?: ReleaseCache
  /** Injected by the tests so nothing exits the test runner. */
  restart?: () => void
  /** Injected by the tests so `--push` never dials a real gateway. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  /** Injected by the tests so a probe and a code exchange can be watched. */
  fetchImpl?: typeof fetch
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)

  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store'
  })
  response.end(payload)
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  })
  response.end(body)
}

/** At most 64 KiB of JSON off a request body; more than that is not a setup form. */
const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length

    if (size > MAX_BODY_BYTES) {
      throw new Error('the request body is too large')
    }

    chunks.push(buffer)
  }

  if (!chunks.length) {
    return {}
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

/**
 * How long the gateway's public surface is held before it is read again.
 *
 * The app asks for it on every load, and it changes when somebody restarts the
 * gateway with another provider — which is minutes apart at worst, never
 * seconds. A minute keeps a tab refresh free and still notices a change while
 * the operator is still looking at the terminal they made it in.
 */
const PROBE_TTL_MS = 60_000

export async function startHermieWeb(input: StartOptions = {}): Promise<HermieWebServer> {
  const first = resolveOptions(input)
  /*
    A gateway the operator SAVED is a gateway the operator chose, so it is read
    before anything else and makes this a configured start. It is only consulted
    when no flag and no environment variable already answered: a `--gateway` on
    the command line beats a file every time, or an operator could not override
    their own deployment without deleting state.
  */
  const saved = first.gatewayConfigured ? null : await readSetup(first.stateDir)
  const options = saved
    ? resolveOptions({
        ...input,
        gatewayUrl: saved.gatewayUrl,
        gatewayConfigured: true,
        ...(saved.publicUrl ? { publicUrl: saved.publicUrl } : {})
      })
    : first
  const fetchImpl = input.fetchImpl ?? fetch
  const releases = input.releaseCache ?? new ReleaseCache()
  const shape = detectInstallShape({ selfUpdate: options.selfUpdate, installRoot: options.installRoot })
  // Mutable, and mutated in exactly one place: the single unconfigured →
  // configured transition in `handleSetup`. Nothing else in this process can
  // move it, and once moved there is no route back.
  const target = { gatewayUrl: options.gatewayUrl, publicUrl: options.publicUrl }
  let configured = options.gatewayConfigured
  /** The operator's in-flight service sign-in, minted by `/hermie/setup/login`. */
  let pendingLogin: (Pkce & { gatewayUrl: string; redirectUri: string }) | null = null
  let probeCache: { at: number; probe: SetupProbe } | null = null
  const cache = new TranscriptCache({
    dir: cacheDir(options.stateDir),
    maxBytes: Math.round(options.cacheMaxMb * 1024 * 1024)
  })
  let updating = false
  // Assigned once the listener is up; the handler reads it, so it is declared
  // here rather than beside the `await` that fills it.
  let push: PushDaemon | null = null

  // Warm the release listing at startup so the first Settings visit is instant,
  // and never let its failure take the server down with it.
  if (options.selfUpdate) {
    void releases.get().catch(() => undefined)
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        json(response, 500, { error: 'hermie_web_failed', detail: String(error) })

        return
      }

      response.end()
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const method = request.method ?? 'GET'

    if (url.pathname === '/healthz') {
      json(response, 200, { ok: true, version: options.version })

      return
    }

    if (url.pathname === '/hermie/config.json') {
      await handleConfig(response)

      return
    }

    if (url.pathname === '/hermie/update') {
      await handleUpdate(request, response, method, url)

      return
    }

    if (url.pathname.startsWith('/hermie/cache/')) {
      await handleCacheRead(request, response, method, url)

      return
    }

    if (url.pathname === '/setup' || url.pathname.startsWith('/hermie/setup/')) {
      await handleSetup(request, response, method, url)

      return
    }

    /*
      Nothing to proxy TO yet.

      Without this the default gateway — the port `hermes serve` usually takes —
      would be dialled by an install that has never been told about a gateway at
      all, and the browser would read the connection failure as "your gateway is
      down" rather than as "nobody has set this up". The status code is the one
      the app already treats as "the gateway is not answering", and the body
      names the page that fixes it.
    */
    if (!configured && isGatewayPath(url.pathname)) {
      json(response, 503, {
        error: 'setup_required',
        detail: 'This Hermie Web has no gateway yet. Open /setup.'
      })

      return
    }

    if (url.pathname === PUSH_PUBLIC_KEY_PATH) {
      // The browser build needs this before it can subscribe, and it has
      // nowhere else to get it: the key is the daemon's, generated on its first
      // run, and the app never talks to the daemon by any other route.
      if (!push?.vapidPublicKey) {
        json(response, 503, {
          error: 'push_unavailable',
          detail: 'This Hermie Web is not running the push daemon (start it with --push).'
        })

        return
      }

      json(response, 200, { publicKey: push.vapidPublicKey, version: options.version })

      return
    }

    if (isGatewayPath(url.pathname)) {
      proxyHttp(request, response, target, observeForCache(method, url))

      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    // The app cannot render anything useful against a gateway that does not
    // exist, so the root is the setup page until there is one.
    if (!configured && url.pathname === '/') {
      response.writeHead(302, { location: '/setup', 'cache-control': 'no-store' })
      response.end()

      return
    }

    if (await serveStatic({ root: options.staticDir, pathname: url.pathname, method, response })) {
      return
    }

    if (await serveIndex(options.staticDir, method, response)) {
      return
    }

    json(response, 404, {
      error: 'no_web_build',
      detail: `There is no web build at ${options.staticDir}. Run \`npm run web:build\`, or pass --static.`
    })
  }

  /**
   * What the gateway's public surface says today, at most once a minute.
   *
   * A failure is cached as "nothing known" rather than retried on every load:
   * the app falls back to probing the gateway itself, which is what the browser
   * build did before this endpoint existed, so a gateway that is briefly down
   * costs a slower sign-in screen and never a stuck one.
   */
  async function gatewayProbe(): Promise<SetupProbe | null> {
    if (!configured) {
      return null
    }

    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
      return probeCache.probe
    }

    try {
      const probe = await probeGateway(target.gatewayUrl, fetchImpl)
      probeCache = { at: Date.now(), probe }

      return probe
    } catch {
      return null
    }
  }

  /**
   * The bootstrap the browser build reads before it renders anything
   * (ADR-0024): where the gateway is, what it takes to sign in to it, what this
   * service is running, and which Hermie Web this is.
   *
   * Everything here is either public or about this process. Nothing in it
   * depends on who is asking, which is why it is answered without a session —
   * the sign-in screen has to be able to draw itself before there is one.
   */
  async function handleConfig(response: ServerResponse): Promise<void> {
    const probe = await gatewayProbe()

    json(response, 200, {
      gatewayHost: new URL(target.publicUrl).host,
      gatewayOrigin: new URL(target.publicUrl).origin,
      loginReturn: options.loginReturn,
      version: options.version,
      setupRequired: !configured,
      // `null` and `[]` are different answers and the app reads them as such:
      // an empty list is a gateway that asks for nothing, `null` is a gateway
      // we could not read, and only the second means "probe it yourself".
      authRequired: probe ? probe.authRequired : null,
      authKinds: probe ? probe.authFlows : null,
      providers: probe ? probe.providers : null,
      service: {
        /** A stored service sign-in, which is what push and the cache are spent on. */
        login: Boolean(push?.credentials.mode === 'oidc' || options.gatewayToken),
        push: Boolean(push),
        cache: cache.enabled
      }
    })
  }

  /**
   * One session's cached tail, for the seam that paints a chat before the
   * socket has answered (ADR-0024).
   *
   * **It requires the caller's own gateway session**, checked the same way
   * `POST /hermie/update` checks it: by putting their cookies to
   * `/api/auth/me`. The cache is gateway-wide rather than per person — there is
   * no ownership field to key it on — but "shared among everyone signed in to
   * this gateway" is a long way from "readable by anything that can reach this
   * port", and this is the check that keeps those two apart.
   *
   * The key may be the runtime session id, the stored session id or the bot's
   * profile name. All three name one chat, because by ADR-0007 there is one
   * canonical Bot Chat per bot — and the seam in the browser holds the bot's
   * name, not a session id, at the moment it has to ask.
   */
  async function handleCacheRead(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    if (!cache.enabled) {
      json(response, 404, { error: 'cache_disabled' })

      return
    }

    if (!configured) {
      json(response, 503, { error: 'setup_required' })

      return
    }

    /*
      The session check applies to a gateway that HAS sessions.

      On an ungated one there is no cookie to present and no identity to check:
      `/api/sessions/<id>/messages` is proxied to anyone who can reach this
      port, so refusing the cached copy of the same rows would protect nothing
      and turn the cache off for every ungated deployment. A gateway we could
      not read is treated as gated, because the safe reading of "unknown" is the
      one that asks for a credential.
    */
    const probe = await gatewayProbe()

    if (
      probe?.authRequired !== false &&
      !(await hasGatewaySession({ gatewayUrl: target.gatewayUrl, cookie: request.headers.cookie }))
    ) {
      json(response, 401, { error: 'unauthorized' })

      return
    }

    const key = decodeURIComponent(url.pathname.slice('/hermie/cache/'.length))
    const entry = await cache.get(key)

    if (!entry) {
      json(response, 404, { error: 'not_cached' })

      return
    }

    json(response, 200, {
      sessionId: entry.sessionId,
      bot: entry.bot,
      storedId: entry.storedId,
      // The transport the rows came off. `rowsToItems` needs it, and reading a
      // REST tail as an RPC one loses every row id — which is precisely what
      // would make the reconcile hand out new ids and move the view.
      shape: entry.shape,
      updatedAt: entry.updatedAt,
      rows: entry.rows
    })
  }

  /**
   * Copy a proxied transcript read into the cache on its way past.
   *
   * This is the half of the feed that works with no `--push` at all: the app
   * asks for a long chat's tail, the gateway answers it, and the same bytes
   * that paint this browser's chat become the thing that paints the next one's.
   * Nothing is added to the request and nothing is changed in the answer.
   */
  function observeForCache(method: string, url: URL): ProxyObserver | undefined {
    if (!cache.enabled || method !== 'GET') {
      return undefined
    }

    const sessionId = sessionIdOfMessagesPath(url.pathname)

    if (!sessionId) {
      return undefined
    }

    return upstream => {
      if (
        !isCapturableAnswer({
          statusCode: upstream.statusCode,
          contentType: String(upstream.headers['content-type'] ?? ''),
          contentEncoding: String(upstream.headers['content-encoding'] ?? '')
        })
      ) {
        return null
      }

      const chunks: Buffer[] = []
      let size = 0
      let abandoned = false

      return chunk => {
        if (abandoned) {
          return
        }

        if (chunk) {
          size += chunk.length

          if (size > MAX_CAPTURE_BYTES) {
            // A transcript larger than the cap is a transcript this cache has
            // no business holding. Drop the copy and keep the buffers.
            abandoned = true
            chunks.length = 0

            return
          }

          chunks.push(chunk)

          return
        }

        try {
          const rows = rowsOfMessagesBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)

          void cache.put({ sessionId, bot: '', storedId: '', shape: 'rest', rows, updatedAt: 0 }).catch(() => undefined)
        } catch {
          // Not the answer we thought it was. Nothing is stored, and the
          // browser already has the bytes.
        }

        chunks.length = 0
      }
    }
  }

  /**
   * The operator setup page and its three calls, alive only while no gateway is
   * configured.
   *
   * The 404 is deliberate rather than a 403: once this deployment is set up,
   * these paths do not exist, and a page that says "forbidden" invites somebody
   * to go looking for the way in.
   */
  async function handleSetup(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (configured) {
      json(response, 404, { error: 'not_found' })

      return
    }

    if (url.pathname === '/setup') {
      if (method !== 'GET' && method !== 'HEAD') {
        json(response, 405, { error: 'method_not_allowed' })

        return
      }

      html(response, 200, setupPage({ version: options.version, defaultGateway: options.gatewayUrl }))

      return
    }

    if (url.pathname === SETUP_CALLBACK_PATH) {
      await handleSetupCallback(response, url)

      return
    }

    if (method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    let body: Record<string, unknown>

    try {
      body = await readJsonBody(request)
    } catch (error) {
      json(response, 400, { error: 'bad_request', detail: String(error) })

      return
    }

    let gatewayUrl: string

    try {
      gatewayUrl = normalizeGatewayInput(typeof body.gateway === 'string' ? body.gateway : '')
    } catch (error) {
      json(response, 400, { error: 'bad_gateway_address', detail: (error as Error).message })

      return
    }

    if (url.pathname === '/hermie/setup/probe') {
      try {
        json(response, 200, { gateway: gatewayUrl, probe: await probeGateway(gatewayUrl, fetchImpl) })
      } catch (error) {
        json(response, 400, { error: 'probe_failed', detail: (error as Error).message })
      }

      return
    }

    if (url.pathname === '/hermie/setup/login') {
      const pkce = createPkce()
      const redirectUri = `${ownOrigin(request)}${SETUP_CALLBACK_PATH}`
      pendingLogin = { ...pkce, gatewayUrl, redirectUri }

      json(response, 200, {
        authorizeUrl: buildAuthorizeUrl(gatewayUrl, {
          challenge: pkce.challenge,
          state: pkce.state,
          redirectUri,
          ...(typeof body.provider === 'string' && body.provider ? { provider: body.provider } : {})
        })
      })

      return
    }

    if (url.pathname === '/hermie/setup/save') {
      await writeSetup(options.stateDir, {
        gatewayUrl,
        publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : '',
        savedAt: Math.floor(Date.now() / 1000)
      })

      // The single transition. `publicUrl` is recomputed from the gateway the
      // same way `resolveOptions` would have, because the operator gave one or
      // they did not and the derivation is the same either way.
      target.gatewayUrl = new URL(gatewayUrl).toString()
      target.publicUrl =
        typeof body.publicUrl === 'string' && body.publicUrl
          ? new URL(body.publicUrl).origin
          : new URL(gatewayUrl).origin
      configured = true
      probeCache = null

      console.warn(`hermie-web: gateway set to ${target.gatewayUrl} through /setup; /setup is now closed.`)
      // Push and the cache hold a connection that was not started, because at
      // startup there was nothing to connect to. Said plainly rather than left
      // for the operator to notice from an absence.
      json(response, 200, { ok: true, gateway: target.gatewayUrl, restartFor: options.push ? ['push'] : [] })

      return
    }

    json(response, 404, { error: 'not_found' })
  }

  /**
   * The end of the service sign-in, run in the operator's browser instead of on
   * a loopback port.
   *
   * `push/login.ts` is the specification: the same PKCE pair, the same one-time
   * code, and the same refusal when the provider issues no refresh token — an
   * hour-long credential is not a credential a daemon can hold, and storing one
   * would mean push stopping in the night with nothing to say why.
   */
  async function handleSetupCallback(response: ServerResponse, url: URL): Promise<void> {
    const pending = pendingLogin
    pendingLogin = null

    if (!pending) {
      html(response, 400, setupCallbackPage('Nothing was waiting', 'Start the service sign-in from the setup page.'))

      return
    }

    const failure = url.searchParams.get('error')

    if (failure) {
      html(
        response,
        400,
        setupCallbackPage('Sign-in failed', `${failure}: ${url.searchParams.get('error_description') ?? ''}`)
      )

      return
    }

    const code = url.searchParams.get('code')

    if (!code || url.searchParams.get('state') !== pending.state) {
      // Either the redirect carried no code, or somebody else's redirect landed
      // here. Neither is a sign-in, and nothing is stored for either.
      html(
        response,
        400,
        setupCallbackPage('Sign-in failed', 'That redirect did not carry the code this server was waiting for.')
      )

      return
    }

    try {
      const tokens = await exchangeCode(pending.gatewayUrl, { code, verifier: pending.verifier }, fetchImpl)
      const state = await loadPushState(options.stateDir)

      if (state.oidc && !sameGateway(state.oidc.gateway, pending.gatewayUrl)) {
        // A credential is only meaningful for the gateway it was made on, and
        // so is everything else in that file.
        state.seq = {}
        state.sent = {}
        state.invalid = {}
        state.tickets = []
      }

      state.oidc = { refreshToken: tokens.refreshToken, provider: tokens.provider, gateway: pending.gatewayUrl }
      await savePushState(options.stateDir, state)

      html(
        response,
        200,
        setupCallbackPage(
          'The service is signed in',
          'Hermie Web stored the sign-in it uses for push and for the message cache.'
        )
      )
    } catch (error) {
      html(response, 400, setupCallbackPage('Sign-in failed', (error as Error).message))
    }
  }

  async function handleUpdate(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL
  ): Promise<void> {
    if (method === 'GET') {
      const release = options.selfUpdate ? await releases.get({ force: url.searchParams.has('refresh') }) : null

      json(response, 200, statusFrom(options.version, release, shape))

      return
    }

    if (method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' })

      return
    }

    // Order matters: refuse an install we could not perform BEFORE asking the
    // gateway who the caller is, so a Docker deployment never sends a request
    // it has no use for.
    if (!shape.canSelfUpdate) {
      json(response, 409, { error: 'self_update_unavailable', reason: shape.reason ?? '' })

      return
    }

    if (!(await hasGatewaySession({ gatewayUrl: target.gatewayUrl, cookie: request.headers.cookie }))) {
      json(response, 401, { error: 'unauthorized', detail: 'Sign in to the gateway before updating Hermie Web.' })

      return
    }

    if (updating) {
      json(response, 409, { error: 'already_updating' })

      return
    }

    const release = await releases.get({ force: true })

    if (!release) {
      json(response, 503, { error: 'no_release', detail: 'The release listing could not be read.' })

      return
    }

    updating = true

    try {
      await applyUpdate({ installRoot: options.installRoot, release })
    } catch (error) {
      updating = false
      json(response, 500, { error: 'update_failed', detail: String(error) })

      return
    }

    json(response, 200, { restarting: true, version: release.version })
    // Answer first, then go away: the browser has to receive this before the
    // socket dies, or the settings row has nothing to poll `/healthz` about.
    response.on('finish', () => {
      const restart = input.restart ?? (() => restartProcess({ supervised: isSupervised() }))
      setTimeout(restart, 100).unref()
    })
  }

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (!isGatewayPath(url.pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')

      return
    }

    proxyUpgrade(request, socket, head, target)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const port = (server.address() as AddressInfo).port
  /*
    The daemon is started AFTER the listener is up, and its failure is not the
    server's. A gateway that is briefly unreachable, a state directory that is
    not writable yet — none of those should mean the browser build stops being
    served, because serving it is the thing this process does that nothing else
    can do for it.

    It is also not started on an UNCONFIGURED process, because there is nothing
    to watch: the gateway is a default nobody chose, and a daemon dialling it
    would fill the log with failures about an address the operator has not named
    yet. `/setup` says so when it saves, rather than leaving it to be noticed
    from an absence.
  */
  push =
    options.push && configured
      ? await startPushDaemon({
          gatewayUrl: target.gatewayUrl,
          gatewayToken: options.gatewayToken,
          stateDir: options.stateDir,
          vapidSubject: options.vapidSubject,
          version: options.version,
          serverRequests: options.pushServerRequests,
          cache,
          ...(input.socketFactory ? { socketFactory: input.socketFactory } : {})
        }).catch((error: unknown) => {
          console.error(`hermie-web: push did not start — ${String(error)}`)

          return null
        })
      : null

  return {
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    port,
    options,
    push,
    cache,
    close: async () => {
      await push?.stop().catch(() => undefined)
      await closeServer(server)
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
