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

  headers.host = publicUrl.host
  // Only when the browser sent one. A same-origin GET has no Origin header, and
  // inventing one would make an ordinary navigation look like a cross-site
  // request to anything downstream that cares.
  if (request.headers.origin !== undefined) {
    headers.origin = publicUrl.origin
  }

  if (request.headers.referer !== undefined) {
    headers.referer = String(request.headers.referer).replace(/^https?:\/\/[^/]+/, publicUrl.origin)
  }

  headers['x-forwarded-proto'] = proto
  headers['x-forwarded-host'] = String(request.headers.host ?? publicUrl.host)
  headers['x-forwarded-for'] = forwardedFor ? `${String(forwardedFor)}, ${clientAddress}` : clientAddress

  return headers
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
 * Proxy one ordinary HTTP request, streaming both bodies.
 *
 * Redirects are NOT followed: the sign-in flow is a chain of 302s that the
 * BROWSER has to walk, because each hop sets cookies on a different origin and
 * the last one lands back on Hermie Web's own `/`. Following them here would
 * collapse the chain into one response and strand every cookie on the way.
 */
export function proxyHttp(request: IncomingMessage, response: ServerResponse, target: ProxyTarget): void {
  const gateway = new URL(target.gatewayUrl)
  const upstreamUrl = new URL(request.url ?? '/', gateway)
  // The gateway's own path prefix, when it is served under one, is part of the
  // base URL; `URL` keeps it because the request path is appended to it here.
  const pathWithPrefix = `${gateway.pathname.replace(/\/+$/, '')}${upstreamUrl.pathname}${upstreamUrl.search}`

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
export function proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget): void {
  const gateway = new URL(target.gatewayUrl)
  const upstreamUrl = new URL(request.url ?? '/', gateway)
  const pathWithPrefix = `${gateway.pathname.replace(/\/+$/, '')}${upstreamUrl.pathname}${upstreamUrl.search}`
  const headers = upstreamHeaders(request, target)

  // The upgrade headers are hop-by-hop and were stripped above, so they are put
  // back deliberately — they are the whole point of this request.
  headers.connection = 'Upgrade'
  headers.upgrade = String(request.headers.upgrade ?? 'websocket')
  // An upgrade always carries an Origin from a browser, and the gateway checks
  // it even when the plain HTTP guard would not have.
  headers.origin = new URL(target.publicUrl).origin

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

  // The gateway answers an ordinary response when it REFUSES the upgrade — a
  // 403 from the Host/Origin guard, a 401 from a bad ticket. That answer is the
  // diagnosis, so it is relayed rather than replaced with a generic failure.
  proxied.on('response', upstream => {
    const lines = [`HTTP/1.1 ${upstream.statusCode ?? 502} ${upstream.statusMessage ?? ''}`, 'connection: close']

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || name.toLowerCase() === 'connection') {
        continue
      }

      for (const entry of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${entry}`)
      }
    }

    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    upstream.pipe(socket)
  })

  proxied.on('error', error => fail(String(error)))
  proxied.end()
}
