/**
 * `--pass-host`: Hermie Web on its own domain, the gateway on its own, and an
 * OIDC sign-in that finishes on Hermie Web's.
 *
 * The stub below models the fullstackstudio-org gateway's origin rules
 * (`hermes_cli/dashboard_auth/origins.py`, `web_server._is_accepted_host`,
 * `web_server_origin_guard.py`) closely enough to say what the gateway would
 * decide:
 *
 *  - the Host guard accepts every LISTED hostname (any port) and, on a
 *    loopback bind, the loopback names; anything else is a 400;
 *  - a request's origin is its `Host` — or the first `X-Forwarded-Host` — with
 *    the scheme from `X-Forwarded-Proto`, both honoured only from a TRUSTED
 *    peer; otherwise the scheme is the socket's own (`http`);
 *  - the OIDC `redirect_uri` is the listed URL of that origin (a port-less
 *    host matches the one listed origin with that scheme and host), else the
 *    primary;
 *  - a WebSocket `Origin` naming a listed hostname must match a listed origin
 *    exactly; no Origin is left to the credential check.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { startHermieWeb, type HermieWebServer } from './server'

const GATEWAY_PUBLIC = 'https://hermes.example.com'
const WEB_PUBLIC = 'https://app.example.com'
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 }

interface ForkGateway {
  url: string
  /** Every request's headers as they arrived, in order. */
  seen: IncomingMessage['headers'][]
  close: () => Promise<void>
}

interface ForkOptions {
  publicUrls: string[]
  /** Whether Hermie Web (the socket peer, 127.0.0.1) is a trusted proxy. */
  trustPeer: boolean
  /** `dashboard.write_origin_check`; `auto` (the default) is on with two or more origins. */
  writeOriginCheck?: 'auto' | 'on' | 'off'
}

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() ?? ''

function splitAuthority(value: string): { host: string; port: number | null } {
  const match = /^([^:]+)(?::(\d+))?$/.exec(value.trim().toLowerCase())

  return match ? { host: match[1] as string, port: match[2] ? Number(match[2]) : null } : { host: '', port: null }
}

async function startForkGateway(config: ForkOptions): Promise<ForkGateway> {
  const listed = config.publicUrls.map(url => {
    const parsed = new URL(url)
    const scheme = parsed.protocol.replace(':', '')

    return { scheme, host: parsed.hostname, port: Number(parsed.port) || (DEFAULT_PORTS[scheme] as number), url }
  })
  const gateway: ForkGateway = { url: '', seen: [], close: async () => undefined }

  const hostAccepted = (req: IncomingMessage): boolean => {
    const { host } = splitAuthority(String(req.headers.host ?? ''))

    return listed.some(origin => origin.host === host) || ['127.0.0.1', 'localhost', '::1'].includes(host)
  }

  /*
    `web_server_origin_guard._is_accepted_origin`, for a gateway bound to
    loopback: a non-web Origin is left alone, a listed one is accepted
    exactly, a listed HOSTNAME on another scheme or port only as the
    request's own explicit host:port, and any other web Origin only when it is
    the request's own Host.
  */
  const originAccepted = (req: IncomingMessage): boolean => {
    const origin = String(req.headers.origin ?? '').trim()
    let parsed: URL

    try {
      parsed = new URL(origin)
    } catch {
      return true
    }

    const scheme = parsed.protocol.replace(':', '')

    if (scheme !== 'http' && scheme !== 'https') {
      return true
    }

    const port = Number(parsed.port) || (DEFAULT_PORTS[scheme] as number)
    const request = splitAuthority(String(req.headers.host ?? ''))

    if (listed.some(o => o.scheme === scheme && o.host === parsed.hostname && o.port === port)) {
      return true
    }

    if (listed.some(o => o.host === parsed.hostname)) {
      return request.port !== null && request.host === parsed.hostname && request.port === port
    }

    return (
      (parsed.hostname === request.host && (request.port === null || request.port === port)) ||
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    )
  }

  const writeCheckOn =
    (config.writeOriginCheck ?? 'auto') === 'auto' ? listed.length > 1 : config.writeOriginCheck === 'on'

  const listedOriginFor = (req: IncomingMessage) => {
    const scheme = config.trustPeer ? first(req.headers['x-forwarded-proto']) || 'http' : 'http'
    const authority = (config.trustPeer && first(req.headers['x-forwarded-host'])) || String(req.headers.host ?? '')
    const { host, port } = splitAuthority(authority)
    const exact = listed.find(o => o.scheme === scheme && o.host === host && o.port === (port ?? DEFAULT_PORTS[scheme]))

    if (exact || port !== null) {
      return exact
    }

    const same = listed.filter(o => o.scheme === scheme && o.host === host)

    return same.length === 1 ? same[0] : undefined
  }

  const server: Server = createServer((req, res) => {
    gateway.seen.push(req.headers)

    if (!hostAccepted(req)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Invalid Host header.' }))

      return
    }

    // `_cross_origin_write_refusal`: a write whose browser Origin is neither
    // listed nor the request's own.
    if (writeCheckOn && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && !originAccepted(req)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reason: 'origin_not_listed' }))

      return
    }

    const url = new URL(req.url ?? '/', 'http://stub')

    if (url.pathname === '/api/write') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.headers))

      return
    }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '0.0.0', auth_required: true, auth_flows: ['cookie'] }))

      return
    }

    if (url.pathname === '/api/auth/providers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ providers: [{ name: 'sso', display_name: 'SSO', supports_password: false }] }))

      return
    }

    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.headers))

      return
    }

    if (url.pathname === '/auth/login') {
      const base = (listedOriginFor(req) ?? listed[0])?.url ?? ''
      const idp = new URL('https://idp.example.invalid/authorize')

      idp.searchParams.set('redirect_uri', `${base}/auth/callback`)
      res.writeHead(302, { location: idp.toString(), 'set-cookie': 'hermes_pkce=s; HttpOnly; Secure; Path=/' })
      res.end()

      return
    }

    if (url.pathname === '/auth/callback') {
      res.writeHead(302, { location: '/', 'set-cookie': 'hermes_session_at=a; HttpOnly; Secure; Path=/' })
      res.end()

      return
    }

    res.writeHead(404)
    res.end()
  })

  const sockets = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    gateway.seen.push(req.headers)

    if (!hostAccepted(req) || !originAccepted(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')

      return
    }

    sockets.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify(req.headers)))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  gateway.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  gateway.close = () =>
    new Promise(resolve => {
      sockets.close()
      server.closeAllConnections()
      server.close(() => resolve())
    })

  return gateway
}

let staticDir: string

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-pass-host-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function startWeb(gateway: ForkGateway, extra: Record<string, unknown> = {}): Promise<HermieWebServer> {
  return startHermieWeb({
    gatewayUrl: gateway.url,
    port: 0,
    publicUrl: GATEWAY_PUBLIC,
    staticDir,
    stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-pass-host-state-')),
    version: '9.9.9',
    selfUpdate: false,
    env: {},
    ...extra
  })
}

/** A browser on `https://app.example.com`, arriving through Hermie Web's own TLS ingress. */
function browserGet(
  base: string,
  target: string,
  headers: Record<string, string> = {},
  method = 'GET'
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const url = new URL(base)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: target,
        headers: {
          host: 'app.example.com',
          'x-forwarded-proto': 'https',
          origin: WEB_PUBLIC,
          referer: `${WEB_PUBLIC}/chats`,
          ...headers
        }
      },
      res => {
        let body = ''

        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )

    req.on('error', reject)
    req.end()
  })
}

const redirectUriOf = (location: string | undefined): string =>
  new URL(location ?? 'https://x.invalid').searchParams.get('redirect_uri') ?? ''

describe('against a gateway that lists both origins and trusts Hermie Web', () => {
  let gateway: ForkGateway
  let passing: HermieWebServer
  let rewriting: HermieWebServer

  beforeAll(async () => {
    gateway = await startForkGateway({ publicUrls: [GATEWAY_PUBLIC, WEB_PUBLIC], trustPeer: true })
    passing = await startWeb(gateway, { passHost: true, webPublicUrl: WEB_PUBLIC })
    rewriting = await startWeb(gateway)
  })

  afterAll(async () => {
    await passing.close()
    await rewriting.close()
    await gateway.close()
  })

  it('rewrites Host, Origin and Referer to --public-url by default', async () => {
    const seen = JSON.parse((await browserGet(rewriting.url, '/api/echo')).body) as Record<string, string>

    expect(seen.host).toBe('hermes.example.com')
    expect(seen.origin).toBe(GATEWAY_PUBLIC)
    expect(seen.referer).toBe(`${GATEWAY_PUBLIC}/chats`)
  })

  it('with --pass-host, sends its own host and lets the browser’s Origin and Referer through', async () => {
    const seen = JSON.parse((await browserGet(passing.url, '/api/echo')).body) as Record<string, string>

    expect(seen.host).toBe('app.example.com')
    expect(seen.origin).toBe(WEB_PUBLIC)
    expect(seen.referer).toBe(`${WEB_PUBLIC}/chats`)
    expect(seen['x-forwarded-host']).toBe('app.example.com')
    expect(seen['x-forwarded-proto']).toBe('https')
    expect(seen['x-forwarded-for']).toBeTruthy()
  })

  it('starts an OIDC sign-in whose callback is on Hermie Web’s own origin', async () => {
    const start = await browserGet(passing.url, '/auth/login?provider=sso')

    expect(start.status).toBe(302)
    expect(redirectUriOf(start.headers.location)).toBe(`${WEB_PUBLIC}/auth/callback`)
    // The PKCE cookie reaches the browser, on the host the callback will visit.
    expect(String(start.headers['set-cookie'])).toContain('hermes_pkce=')

    const finish = await browserGet(passing.url, '/auth/callback?code=c&state=s')

    expect(finish.status).toBe(302)
    // Relative: the browser resolves it against app.example.com, where it is.
    expect(finish.headers.location).toBe('/')
    expect(String(finish.headers['set-cookie'])).toContain('hermes_session_at=')
  })

  it('without --pass-host, a trusting gateway still reads the browser’s host from X-Forwarded-Host', async () => {
    // The redirect_uri follows `X-Forwarded-Host` from a trusted peer either
    // way; what --pass-host changes is what the gateway's ORIGIN checks see.
    const start = await browserGet(rewriting.url, '/auth/login?provider=sso')

    expect(redirectUriOf(start.headers.location)).toBe(`${WEB_PUBLIC}/auth/callback`)
  })

  it('lets the gateway see a cross-site Origin for what it is, in either mode', async () => {
    const hostile = { origin: 'https://evil.example', referer: 'https://evil.example/page' }
    const rewritten = JSON.parse((await browserGet(rewriting.url, '/api/echo', hostile)).body) as Record<string, string>
    const passed = JSON.parse((await browserGet(passing.url, '/api/echo', hostile)).body) as Record<string, string>

    // Neither mode turns it into a listed origin, so the gateway can refuse
    // it either way.
    expect(rewritten.origin).toBe('https://evil.example')
    expect(rewritten.referer).toBe('https://evil.example/page')
    expect(passed.origin).toBe('https://evil.example')
    expect(passed.referer).toBe('https://evil.example/page')
  })

  it('answers passHost, origin and an empty loginReturn in /hermie/config.json', async () => {
    const config = JSON.parse((await browserGet(passing.url, '/hermie/config.json')).body) as Record<string, unknown>

    expect(config).toMatchObject({ passHost: true, origin: WEB_PUBLIC, loginReturn: '' })
  })

  it('answers passHost false and no origin without --web-public-url, never the request’s own Host', async () => {
    const config = JSON.parse((await browserGet(rewriting.url, '/hermie/config.json')).body) as Record<string, unknown>

    expect(config).toMatchObject({ passHost: false, origin: null, loginReturn: '/' })
  })

  it.each([
    ['passes the browser’s Origin through on a WebSocket upgrade', true, WEB_PUBLIC, 'app.example.com'],
    ['forces the gateway’s Origin on a WebSocket upgrade without it', false, GATEWAY_PUBLIC, 'hermes.example.com']
  ])('%s', async (_label, pass, wantOrigin, wantHost) => {
    const web = pass ? passing : rewriting
    const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}/api/ws`, {
      headers: { host: 'app.example.com', 'x-forwarded-proto': 'https' },
      origin: WEB_PUBLIC
    })
    const seen = await new Promise<Record<string, string>>((resolve, reject) => {
      socket.on('message', data => resolve(JSON.parse(String(data)) as Record<string, string>))
      socket.on('error', reject)
    })

    socket.close()
    expect(seen.origin).toBe(wantOrigin)
    expect(seen.host).toBe(wantHost)
  })
})

describe('--pass-host with --no-oidc', () => {
  it('still refuses the OIDC routes before they reach the gateway', async () => {
    const gateway = await startForkGateway({ publicUrls: [GATEWAY_PUBLIC, WEB_PUBLIC], trustPeer: true })
    const web = await startWeb(gateway, { passHost: true, webPublicUrl: WEB_PUBLIC, oidc: false })

    try {
      gateway.seen.length = 0

      expect((await browserGet(web.url, '/auth/login?provider=sso')).status).toBe(403)
      expect((await browserGet(web.url, '/auth/callback?code=c&state=s')).status).toBe(403)
      expect(gateway.seen).toEqual([])
    } finally {
      await web.close()
      await gateway.close()
    }
  })
})

describe('--pass-host against a gateway that does not trust Hermie Web as a proxy', () => {
  it('falls back to the primary callback — which is why the docs ask for dashboard.trusted_proxies', async () => {
    const gateway = await startForkGateway({ publicUrls: [GATEWAY_PUBLIC, WEB_PUBLIC], trustPeer: false })
    const web = await startWeb(gateway, { passHost: true, webPublicUrl: WEB_PUBLIC })

    try {
      const start = await browserGet(web.url, '/auth/login?provider=sso')

      expect(redirectUriOf(start.headers.location)).toBe(`${GATEWAY_PUBLIC}/auth/callback`)
    } finally {
      await web.close()
      await gateway.close()
    }
  })
})

describe('--pass-host against a gateway that does not list Hermie Web’s origin', () => {
  it('falls back to rewriting at startup, and says what to add where', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const gateway = await startForkGateway({ publicUrls: [GATEWAY_PUBLIC], trustPeer: true })
    const web = await startWeb(gateway, { passHost: true, webPublicUrl: WEB_PUBLIC })

    try {
      expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain(
        `Add ${WEB_PUBLIC} to dashboard.public_urls on the gateway`
      )

      const seen = JSON.parse((await browserGet(web.url, '/api/echo')).body) as Record<string, string>

      expect(seen.host).toBe('hermes.example.com')
      expect(seen.origin).toBe(GATEWAY_PUBLIC)

      const config = JSON.parse((await browserGet(web.url, '/hermie/config.json')).body) as Record<string, unknown>

      expect(config.passHost).toBe(false)
    } finally {
      await web.close()
      await gateway.close()
    }
  })
})

/*
  The default (rewrite) mode, with the fork's write-request Origin check armed:
  only a browser on Hermie Web's own origin has its Origin rewritten to the
  gateway's. A page on a sibling subdomain — the same SITE, so a SameSite=Lax
  session cookie rides along on its form POST — keeps its own Origin, and the
  gateway refuses it.
*/
describe.each([
  ['two listed origins (write_origin_check auto)', [GATEWAY_PUBLIC, WEB_PUBLIC], 'auto'],
  ['one public URL with write_origin_check on', [GATEWAY_PUBLIC], 'on']
] as const)('the Origin rule without --pass-host, %s', (_label, publicUrls, writeOriginCheck) => {
  let gateway: ForkGateway
  let web: HermieWebServer

  beforeAll(async () => {
    gateway = await startForkGateway({ publicUrls: [...publicUrls], trustPeer: true, writeOriginCheck })
    web = await startWeb(gateway)
  })

  afterAll(async () => {
    await web.close()
    await gateway.close()
  })

  const write = (origin: Record<string, string>) =>
    browserGet(web.url, '/api/write', { 'content-type': 'text/plain', ...origin }, 'POST')

  it('rewrites a same-origin write to the gateway’s Origin, which it accepts', async () => {
    const response = await write({ origin: WEB_PUBLIC })

    expect(response.status).toBe(200)
    expect((JSON.parse(response.body) as Record<string, string>).origin).toBe(GATEWAY_PUBLIC)
  })

  it('lets the gateway refuse a sibling subdomain’s credentialed write', async () => {
    const response = await write({ origin: 'https://tenant-b.example.com', referer: 'https://tenant-b.example.com/x' })

    expect(response.status).toBe(403)
    expect(response.body).toContain('origin_not_listed')
  })

  it('passes a native client’s Origin through, and the gateway accepts it', async () => {
    const response = await write({ origin: 'tauri://localhost' })

    expect(response.status).toBe(200)
    expect((JSON.parse(response.body) as Record<string, string>).origin).toBe('tauri://localhost')
  })

  const upgrade = (origin?: string) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}/api/ws`, {
        headers: { host: 'app.example.com', 'x-forwarded-proto': 'https' },
        ...(origin ? { origin } : {})
      })

      socket.on('message', data => {
        socket.close()
        resolve(JSON.parse(String(data)) as Record<string, string>)
      })
      socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${String(res.statusCode)}`)))
      socket.on('error', reject)
    })

  it('rewrites a same-origin upgrade too', async () => {
    expect((await upgrade(WEB_PUBLIC)).origin).toBe(GATEWAY_PUBLIC)
  })

  it('invents no Origin for an upgrade that sent none', async () => {
    expect((await upgrade()).origin).toBeUndefined()
  })

  it('passes a native client’s Origin through on an upgrade', async () => {
    expect((await upgrade('tauri://localhost')).origin).toBe('tauri://localhost')
  })

  it('lets the gateway refuse a sibling subdomain’s upgrade', async () => {
    await expect(upgrade('https://tenant-b.example.com')).rejects.toThrow(/403/)
  })
})
