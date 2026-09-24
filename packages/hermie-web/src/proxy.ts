/**
 * The proxy half: one fixed gateway, reached over plain `node:http(s)` with the
 * bodies streamed rather than buffered.
 *
 * The whole reason this file exists is the gateway's own guards. `hermes serve`
 * refuses a request whose `Host` is not a host it knows and a WebSocket upgrade
 * whose `Origin` does not match that host — a DNS-rebinding defence, and a good
 * one. A browser talking to Hermie Web sends Hermie Web's address in both, which
 * the gateway has never heard of. So both are rewritten to the gateway's own
 * public URL, and the client's real address travels in `X-Forwarded-For` /
 * `-Proto` / `-Host`, which is where the gateway looks for it when it trusts the
 * proxy (`dashboard.trusted_proxies`).
 *
 * `--pass-host` is the other way round, for a gateway that lists Hermie Web's
 * own origin in `dashboard.public_urls` (the fullstackstudio-org fork): `Host`
 * is Hermie Web's own public host and the browser's `Origin` and `Referer` are
 * left alone, so the gateway knows which of its origins the browser is on and
 * finishes an OIDC sign-in there. `ProxyTarget.passHostOrigin` decides which.
 *
 * Cookies pass both ways untouched except for two attributes, and both edits
 * exist so a cookie set for one origin is accepted on another:
 *
 *  - `Domain` is dropped. The gateway sets none, but a deployment behind
 *    something else might, and a `Domain` naming the gateway's host would make
 *    the browser discard the cookie outright.
 *  - `Secure` is dropped, and `SameSite=None` becomes `Lax`, ONLY when the
 *    browser reached Hermie Web over plain HTTP. A `Secure` cookie on an
 *    `http://` origin is silently thrown away, which looks exactly like a
 *    sign-in that did nothing. What "over plain HTTP" means is decided by
 *    `isSecureRequest`, which reads the reverse proxy's `X-Forwarded-Proto`
 *    before it reads its own socket.
 *
 * `Path` is never touched: the gateway computes it from its own proxy prefix
 * and rewriting it would unscope the session.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'

export interface ProxyTarget {
  /** The fixed gateway origin, e.g. `http://127.0.0.1:9119`. */
  gatewayUrl: string
  /** The origin the gateway believes it is served on. */
  publicUrl: string
  /**
   * Hermie Web's own public origin while `--pass-host` is in effect, else
   * `null` (or absent): rewrite to `publicUrl`, the ordinary behaviour. Set
   * back to `null` by `server.ts` when the gateway refuses this origin.
   */
  passHostOrigin?: string | null
  /**
   * Hermie Web's own configured public origin (`--web-public-url`), whether
   * or not `--pass-host` is in effect: one of the origins `ownOrigins` counts
   * as "a browser on this service". `null` or absent when not configured.
   */
  webOrigin?: string | null
}

/** Headers a hop owns; forwarding them corrupts the next hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/**
 * Did the BROWSER reach us over https?
 *
 * Not "is this socket TLS": Hermie Web speaks plain HTTP and is meant to have
 * something in front of it, so the answer is almost always in the header that
 * something set. Without this the scheme is read off a loopback socket, comes
 * out as `http` on every deployment behind nginx, Caddy or Tailscale Serve, and
 * two things quietly go wrong: the gateway is told `http`, so it issues cookies
 * without `Secure` and without the `__Host-` prefix it would otherwise use, and
 * the rewrite below then strips `Secure` off any that arrive with it.
 *
 * Trusting a header a client could have sent is a real question, and here it is
 * a narrow one. The header decides nothing but the cookie attributes on this
 * same request: a client that lies to itself gets cookies its own browser
 * refuses. It cannot reach another session, and nothing downstream reads it for
 * anything but this.
 */
export function isSecureRequest(request: IncomingMessage): boolean {
  const socket = request.socket as { encrypted?: boolean }

  if (socket.encrypted === true) {
    return true
  }

  return forwardedProto(request) === 'https'
}

/** The first hop's scheme from `X-Forwarded-Proto`, lowercased; `''` when unset. */
function forwardedProto(request: IncomingMessage): string {
  const raw = request.headers['x-forwarded-proto']
  const first = Array.isArray(raw) ? raw[0] : raw

  return (first ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
}

/**
 * The headers one proxied request goes out with.
 *
 * Exported because it is the piece worth testing on its own: everything the
 * gateway's guards look at is decided here.
 */
export function upstreamHeaders(request: IncomingMessage, target: ProxyTarget): Record<string, string | string[]> {
  const publicUrl = new URL(target.publicUrl)
  const headers: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue
    }

    headers[name] = value
  }

  const proto = isSecureRequest(request) ? 'https' : 'http'
  const forwardedFor = request.headers['x-forwarded-for']
  const clientAddress = request.socket.remoteAddress ?? ''

  const passing = target.passHostOrigin ? new URL(target.passHostOrigin) : null

  if (passing) {
    // `--pass-host`: this service's own public host, and the browser's own
    // `Origin` and `Referer` exactly as it sent them (copied above). The
    // gateway holds all three to its listed origins itself.
    headers.host = passing.host
  } else {
    headers.host = publicUrl.host
    rewriteOwnOrigin(request, target, headers)
  }

  headers['x-forwarded-proto'] = proto
  headers['x-forwarded-host'] = String(request.headers.host ?? (passing ?? publicUrl).host)
  headers['x-forwarded-for'] = forwardedFor ? `${String(forwardedFor)}, ${clientAddress}` : clientAddress

  return headers
}

/**
 * The origins a browser on THIS service sends: `--web-public-url` when it is
 * set (exactly), and whatever this request says it was addressed to — its
 * `Host`, and the `X-Forwarded-Host` Hermie Web's own TLS proxy set — on
 * either scheme. A page on another origin cannot forge any of these on a
 * cross-site request: `Host` is the target the browser was sent to, and a
 * browser does not let script set either header without a preflight that
 * fails. Both schemes, because a TLS proxy that sends no `X-Forwarded-Proto`
 * leaves this service believing `http` while the browser's `Origin` says
 * `https`; the host and port are what cannot be forged, not the scheme.
 */
export function ownOrigins(request: IncomingMessage, target: ProxyTarget): Set<string> {
  const out = new Set<string>()
  const add = (candidate: string): void => {
    try {
      out.add(new URL(candidate).origin)
    } catch {
      // A header that does not make an origin names nothing to match.
    }
  }

  if (target.webOrigin) {
    add(target.webOrigin)
  }

  for (const name of ['host', 'x-forwarded-host'] as const) {
    const raw = request.headers[name]
    const host = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim()

    if (host && !/[\s/\\@?#]/.test(host)) {
      add(`http://${host}`)
      add(`https://${host}`)
    }
  }

  return out
}

/** The origin of a web (`http:`/`https:`) URL, or `null` for anything else. */
function webOriginOf(value: string): string | null {
  try {
    const url = new URL(value)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * The default (rewrite) mode's `Origin` and `Referer`, on a plain request and
 * on an upgrade alike.
 *
 * The gateway has never heard of Hermie Web's own origin, so a browser on it
 * has its `Origin` rewritten to the gateway's `publicUrl` — and ONLY a
 * browser on it. Every other `Origin` passes through untouched, so the
 * gateway's own guards (its WebSocket `Origin` check, and the fork's
 * write-request check) refuse it unless it is one they list. Rewriting ANY
 * `Origin` would launder a cross-site one — a script on a sibling subdomain
 * sending a credentialed form POST, say, with the `SameSite=Lax` session
 * cookie attached because the two are the same site — into the gateway's
 * own, which every such check accepts.
 *
 *  - No `Origin`: none is invented.
 *  - A non-web one (`null`, `file://`, `app://`, `tauri://`, `capacitor://`):
 *    passed through; the gateway classifies those itself, as it would for a
 *    client that reached it directly.
 *  - `Referer`: rewritten only when it is on an own origin, else passed
 *    through.
 */
function rewriteOwnOrigin(
  request: IncomingMessage,
  target: ProxyTarget,
  headers: Record<string, string | string[]>
): void {
  const publicOrigin = new URL(target.publicUrl).origin
  const own = ownOrigins(request, target)
  const origin = request.headers.origin

  if (typeof origin === 'string') {
    const web = webOriginOf(origin.trim())

    if (web && own.has(web)) {
      headers.origin = publicOrigin
    }
  }

  const referer = request.headers.referer

  if (typeof referer === 'string') {
    const web = webOriginOf(referer)

    if (web && own.has(web)) {
      // Rebuilt from the parsed URL rather than sliced from the raw string, so
      // an uppercase host, an explicit default port or userinfo in it cannot
      // shift where the path starts.
      const url = new URL(referer)

      headers.referer = `${publicOrigin}${url.pathname}${url.search}`
    }
  }
}

/** Rewrite one `Set-Cookie` line for the origin the browser actually used. */
export function rewriteSetCookie(value: string, secureClient: boolean): string {
  const parts = value.split(';').map(part => part.trim())
  const out: string[] = []

  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      out.push(part)

      continue
    }

    const lower = part.toLowerCase()

    if (lower.startsWith('domain=')) {
      continue
    }

    if (lower === 'secure' && !secureClient) {
      continue
    }

    if (lower === 'samesite=none' && !secureClient) {
      out.push('SameSite=Lax')

      continue
    }

    out.push(part)
  }

  return out.join('; ')
}

export function downstreamHeaders(upstream: IncomingMessage, secureClient: boolean): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue
    }

    if (name.toLowerCase() === 'set-cookie') {
      headers['set-cookie'] = (Array.isArray(value) ? value : [value]).map(entry =>
        rewriteSetCookie(entry, secureClient)
      )

      continue
    }

    headers[name] = value
  }

  return headers
}

function agentFor(url: URL) {
  return url.protocol === 'https:' ? https : http
}

/**
 * A look at one proxied answer on its way past, for the message cache
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * Called with the upstream response as soon as its head arrives; returning a
 * sink asks for the body bytes too, and the sink is called once more with
 * `null` when the body ends. Returning `null` costs nothing at all.
 *
 * The proxy still pipes exactly what it received — the observer is a copy, not
 * a filter — so an observer that throws, hangs or fills its buffer can never
 * change what the browser is served.
 */
export type ProxyObserver = (upstream: IncomingMessage) => ((chunk: Buffer | null) => void) | null

/**
 * Proxy one ordinary HTTP request, streaming both bodies.
 *
 * Redirects are NOT followed: the sign-in flow is a chain of 302s that the
 * BROWSER has to walk, because each hop sets cookies on a different origin and
 * the last one lands back on Hermie Web's own `/`. Following them here would
 * collapse the chain into one response and strand every cookie on the way.
 *
 * `verbatimPathAndQuery`, when given, is sent upstream EXACTLY as it is,
 * behind the gateway's own path prefix: no `URL` parse, no decoding, no
 * re-encoding, no dot-segment or backslash normalisation. `server.ts`'s
 * `--no-oidc` check passes the raw request target here, because it decided on
 * those same bytes decoded once the way the gateway decodes them — and any
 * rewrite in between (a decode, above all) would hand the gateway a path the
 * check never saw. See the comment at that decision for the whole argument.
 */
export function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  target: ProxyTarget,
  observe?: ProxyObserver,
  verbatimPathAndQuery?: string
): void {
  const gateway = new URL(target.gatewayUrl)
  // The gateway's own path prefix, when it is served under one, is part of the
  // base URL and goes in front of the request path either way.
  const prefix = gateway.pathname.replace(/\/+$/, '')
  let pathWithPrefix: string

  if (verbatimPathAndQuery !== undefined) {
    pathWithPrefix = `${prefix}${verbatimPathAndQuery}`
  } else {
    const upstreamUrl = new URL(request.url ?? '/', gateway)

    pathWithPrefix = `${prefix}${upstreamUrl.pathname}${upstreamUrl.search}`
  }

  const proxied = agentFor(gateway).request(
    {
      protocol: gateway.protocol,
      hostname: gateway.hostname,
      port: gateway.port || (gateway.protocol === 'https:' ? 443 : 80),
      method: request.method ?? 'GET',
      path: pathWithPrefix,
      headers: upstreamHeaders(request, target)
    },
    upstream => {
      response.writeHead(upstream.statusCode ?? 502, downstreamHeaders(upstream, isSecureRequest(request)))

      let sink: ((chunk: Buffer | null) => void) | null = null

      try {
        sink = observe?.(upstream) ?? null
      } catch {
        // An observer that throws on the head is an observer that gets nothing.
        // It must not cost the response it was watching.
        sink = null
      }

      if (sink) {
        const feed = sink
        /*
          Attached BEFORE the pipe, and in the same synchronous block.

          A `data` listener switches the stream to flowing mode, and flowing
          starts on the next tick — so as long as `pipe` is attached in this
          same block, both receive every chunk and the browser is served
          exactly what arrived. Attaching it after an `await` would drop the
          first chunks into the pipe alone, which reads as a truncated cache
          entry and nothing else.
        */
        upstream.on('data', (chunk: Buffer) => {
          try {
            feed(chunk)
          } catch {
            // Same rule as above: the copy fails, the response does not.
          }
        })
        upstream.on('end', () => {
          try {
            feed(null)
          } catch {
            // Same rule again.
          }
        })
      }

      upstream.pipe(response)
    }
  )

  proxied.on('error', error => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }

    response.end(JSON.stringify({ error: 'gateway_unreachable', detail: String(error) }))
  })

  request.pipe(proxied)
}

/**
 * Proxy one WebSocket upgrade by piping the raw sockets.
 *
 * Deliberately NOT a `ws` server talking to a `ws` client. The gateway selects a
 * subprotocol from the list the browser offered — one of which carries a
 * single-use ticket — and terminating the WebSocket here would mean re-offering
 * that list, re-reading the selection and re-framing every message, for no
 * benefit. Piping the bytes means the subprotocol negotiation, the close codes
 * and the frame boundaries are all exactly what the two ends agreed, and it is
 * why this package has no runtime dependencies at all.
 */
export function proxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
  verbatimPathAndQuery?: string
): void {
  const gateway = new URL(target.gatewayUrl)
  // Forwarded exactly as `proxyHttp` forwards it — see that function's note.
  const prefix = gateway.pathname.replace(/\/+$/, '')
  let pathWithPrefix: string

  if (verbatimPathAndQuery !== undefined) {
    pathWithPrefix = `${prefix}${verbatimPathAndQuery}`
  } else {
    const upstreamUrl = new URL(request.url ?? '/', gateway)

    pathWithPrefix = `${prefix}${upstreamUrl.pathname}${upstreamUrl.search}`
  }
  const headers = upstreamHeaders(request, target)

  // The upgrade headers are hop-by-hop and were stripped above, so they are put
  // back deliberately — they are the whole point of this request.
  headers.connection = 'Upgrade'
  headers.upgrade = String(request.headers.upgrade ?? 'websocket')
  // `upstreamHeaders` already applied the same Origin rule the plain request
  // gets: under `--pass-host` the browser's own Origin, otherwise Hermie Web's
  // own origin rewritten to the gateway's and every other one passed through
  // for the gateway to judge. None is invented: a client that sent no Origin
  // (not a browser) is left to the gateway's credential check.

  const proxied = agentFor(gateway).request({
    protocol: gateway.protocol,
    hostname: gateway.hostname,
    port: gateway.port || (gateway.protocol === 'https:' ? 443 : 80),
    method: request.method ?? 'GET',
    path: pathWithPrefix,
    headers
  })

  const fail = (reason: string) => {
    if (!socket.destroyed) {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n${reason}`)
    }
  }

  proxied.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstream.statusCode ?? 101} ${upstream.statusMessage ?? 'Switching Protocols'}`]

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined) {
        continue
      }

      for (const entry of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${entry}`)
      }
    }

    socket.write(`${lines.join('\r\n')}\r\n\r\n`)

    if (upstreamHead.length > 0) {
      socket.write(upstreamHead)
    }

    if (head.length > 0) {
      upstreamSocket.write(head)
    }

    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })

  /*
    The gateway answers an ordinary response when it REFUSES the upgrade — a
    403 from the Host/Origin guard, a 401 from a bad ticket. Only the STATUS
    is relayed: no upstream header and no body. A browser's WebSocket API can
    read neither (it sees a failed connection and nothing more), so nothing
    legitimate loses anything, and the status is still there for anybody
    diagnosing with curl. What a relayed header could carry is the problem:
    a non-101 answer is by definition the gateway serving this request as
    something other than a WebSocket, and its `Set-Cookie` or `Location` —
    a session, a PKCE cookie, an identity provider redirect — must never
    reach a client through a path none of the HTTP checks ran on.
  */
  proxied.on('response', upstream => {
    const status =
      upstream.statusCode && upstream.statusCode >= 200 && upstream.statusCode <= 599 ? upstream.statusCode : 502

    upstream.resume()
    socket.end(`HTTP/1.1 ${String(status)} Upgrade Refused\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  })

  proxied.on('error', error => fail(String(error)))
  proxied.end()
}

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/** The most a probe answer may be; the real ones are a few hundred bytes. */
const HOST_PINNED_MAX_BODY = 1024 * 1024

/** A ceiling of its own, for a caller that passes no signal. */
const HOST_PINNED_TIMEOUT_MS = 10_000

/**
 * A `fetch` for this service's OWN small requests to the gateway — the setup
 * probe — that sends the same `Host` `proxyHttp` does.
 *
 * The platform `fetch` will not send a `Host` of the caller's choosing, so a
 * gateway whose Host guard is armed refuses the probe while it accepts every
 * proxied request. That failure is fail-closed (no provider list, so
 * `--no-oidc` refuses native sign-in), but it is still a probe answering a
 * different question from the one the browser's requests ask. Only what the
 * probe uses is supported: a URL string, a method, headers, a signal, and a
 * buffered body in the answer — at most `HOST_PINNED_MAX_BODY`, within
 * `HOST_PINNED_TIMEOUT_MS`, and settled exactly once whether the answer ends,
 * errors or is cut off.
 */
export function hostPinnedFetch(host: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers: Record<string, string> = {}

    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    headers.host = host

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const settle = (outcome: () => void): void => {
        if (!settled) {
          settled = true
          outcome()
        }
      }
      const fail = (error: Error): void => settle(() => reject(error))

      const outgoing = agentFor(url).request(
        url,
        { method: init?.method ?? 'GET', headers, ...(init?.signal ? { signal: init.signal } : {}) },
        incoming => {
          const chunks: Buffer[] = []
          let size = 0

          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length

            if (size > HOST_PINNED_MAX_BODY) {
              fail(new Error('gateway answer too large'))
              outgoing.destroy()

              return
            }

            chunks.push(chunk)
          })
          incoming.on('error', fail)
          // `close` without `end` is an answer cut off part-way.
          incoming.on('close', () => {
            if (!incoming.complete) {
              fail(new Error('gateway answer cut off'))
            }
          })
          incoming.on('end', () => {
            const status = incoming.statusCode ?? 502
            const responseHeaders = new Headers()

            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                responseHeaders.append(name, one)
              }
            }

            settle(() =>
              resolve(
                new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
                  status: status < 200 || status > 599 ? 502 : status,
                  headers: responseHeaders
                })
              )
            )
          })
        }
      )

      outgoing.setTimeout(HOST_PINNED_TIMEOUT_MS, () => {
        fail(new Error('gateway did not answer in time'))
        outgoing.destroy()
      })
      outgoing.on('error', fail)
      outgoing.on('close', () => fail(new Error('gateway connection closed')))
      outgoing.end()
    })
  }) as typeof fetch
}
