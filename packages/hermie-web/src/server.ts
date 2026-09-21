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
 *  2. `/api/*`, `/auth/*`, `/login*`, `/logout*` — proxied to the gateway.
 *  3. Anything that names a file in the static build — served from disk.
 *  4. Everything else — `index.html`, so a deep link into the SPA works.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  type HermieWebOptions,
  isGatewayPath,
  PUSH_PUBLIC_KEY_PATH,
  resolveOptions,
  type ResolveOptionsInput
} from './options'
import { type PushDaemon, startPushDaemon } from './push/daemon'
import { proxyHttp, proxyUpgrade } from './proxy'
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
  close(): Promise<void>
}

export interface StartOptions extends ResolveOptionsInput {
  /** Injected by the tests so they never reach GitHub. */
  releaseCache?: ReleaseCache
  /** Injected by the tests so nothing exits the test runner. */
  restart?: () => void
  /** Injected by the tests so `--push` never dials a real gateway. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
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

export async function startHermieWeb(input: StartOptions = {}): Promise<HermieWebServer> {
  const options = resolveOptions(input)
  const releases = input.releaseCache ?? new ReleaseCache()
  const shape = detectInstallShape({ selfUpdate: options.selfUpdate, installRoot: options.installRoot })
  const target = { gatewayUrl: options.gatewayUrl, publicUrl: options.publicUrl }
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
      json(response, 200, {
        gatewayHost: new URL(options.publicUrl).host,
        loginReturn: options.loginReturn,
        version: options.version
      })

      return
    }

    if (url.pathname === '/hermie/update') {
      await handleUpdate(request, response, method, url)

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
      proxyHttp(request, response, target)

      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' })

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

    if (!(await hasGatewaySession({ gatewayUrl: options.gatewayUrl, cookie: request.headers.cookie }))) {
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
  */
  push = options.push
    ? await startPushDaemon({
        gatewayUrl: options.gatewayUrl,
        gatewayToken: options.gatewayToken,
        stateDir: options.stateDir,
        vapidSubject: options.vapidSubject,
        version: options.version,
        serverRequests: options.pushServerRequests,
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
