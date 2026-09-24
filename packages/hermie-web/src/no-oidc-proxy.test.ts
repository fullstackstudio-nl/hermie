/**
 * `--no-oidc` against a gateway that routes the way the real one does.
 *
 * The shared fake gateway routes on `URL.prototype.pathname`, which never
 * decodes a percent-escape, so it cannot show the one thing this file is
 * about: what the GATEWAY does with the bytes this proxy forwards. The stub
 * below models the Hermes gateway's own stack instead — uvicorn percent-decodes
 * the path exactly once before routing, drops a fragment, and FastAPI binds a
 * repeated query parameter to its LAST value — and it implements the three
 * auth routes (`hermes_cli/dashboard_auth/routes.py`) closely enough to say
 * which handler a request actually reached. Every assertion that matters here
 * is about that: whether an OIDC round trip was started at the gateway, not
 * only what status this proxy answered.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { startHermieWeb, type HermieWebServer } from './server'

const PUBLIC_HOST = 'hermes.example.test'

/** Every WebSocket route the gateway has (`web_routers/chat_ws.py`, `display.py`, `audio.py`). */
const GATEWAY_WEBSOCKET_ROUTES = [
  '/api/ws',
  '/api/pty',
  '/api/console',
  '/api/pub',
  '/api/events',
  '/api/display/ws',
  '/api/audio/speak-stream'
]

interface StubProvider {
  name: string
  password: boolean
}

interface StubGateway {
  url: string
  /** Every request target exactly as it arrived on the wire. */
  targets: string[]
  /** Every `Host` header, in arrival order. */
  hosts: string[]
  /** The auth handlers that started or finished a provider round trip. */
  oidcReached: string[]
  providers: StubProvider[]
  requireHost: boolean
  close: () => Promise<void>
}

/** Python's `urllib.parse.unquote`: `%XX` pairs only, invalid ones left alone, UTF-8 with replacement. */
function pythonUnquote(value: string): string {
  const bytes: number[] = []

  for (let at = 0; at < value.length; at++) {
    const pair = value.slice(at + 1, at + 3)

    if (value[at] === '%' && /^[0-9a-fA-F]{2}$/.test(pair)) {
      bytes.push(parseInt(pair, 16))
      at += 2
    } else {
      bytes.push(...Buffer.from(value[at] as string, 'utf8'))
    }
  }

  return Buffer.from(bytes).toString('utf8')
}

/** Starlette's query parsing as FastAPI binds a scalar: the LAST value of a repeated name wins. */
function lastWins(query: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const [name, value] of new URLSearchParams(query)) {
    out.set(name, value)
  }

  return out
}

async function startStubGateway(providers: StubProvider[], requireHost = false): Promise<StubGateway> {
  const stub: StubGateway = {
    url: '',
    targets: [],
    hosts: [],
    oidcReached: [],
    providers,
    requireHost,
    close: async () => undefined
  }

  const redirect = (res: ServerResponse, location: string): void => {
    res.writeHead(302, { location })
    res.end()
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const target = req.url ?? '/'

    stub.targets.push(target)
    stub.hosts.push(String(req.headers.host ?? ''))

    if (stub.requireHost && req.headers.host !== PUBLIC_HOST) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Invalid host header' }))

      return
    }

    // httptools: path, query and fragment apart; the path decoded ONCE.
    const withoutFragment = target.split('#')[0] as string
    const queryAt = withoutFragment.indexOf('?')
    const rawPath = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)
    const query = lastWins(queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1))
    const route = pythonUnquote(rawPath)
    const sessionProviders = stub.providers

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (route === '/api/status') {
      json(200, { version: '0.0.0', auth_required: true, auth_flows: ['cookie'] })

      return
    }

    if (route === '/api/auth/providers') {
      json(200, {
        providers: sessionProviders.map(p => ({ name: p.name, display_name: p.name, supports_password: p.password }))
      })

      return
    }

    if (route === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><form id="password-form"><input name="username"></form>')

      return
    }

    if (route === '/auth/login') {
      const p = sessionProviders.find(one => one.name === (query.get('provider') ?? ''))

      if (!p) {
        json(404, { detail: 'Unknown provider' })

        return
      }

      if (p.password) {
        redirect(res, '/login')

        return
      }

      stub.oidcReached.push(`auth_login:${p.name}`)
      res.setHeader('set-cookie', 'hermes_pkce=state-and-verifier; HttpOnly; Path=/')
      redirect(res, 'https://idp.example.invalid/authorize')

      return
    }

    if (route === '/auth/callback') {
      stub.oidcReached.push('auth_callback')
      res.setHeader('set-cookie', 'hermes_session_at=session; HttpOnly; Path=/')
      redirect(res, '/')

      return
    }

    if (route === '/auth/native/authorize') {
      const named = query.get('provider') ?? ''
      const p = named
        ? sessionProviders.find(one => one.name === named)
        : sessionProviders.length === 1
          ? sessionProviders[0]
          : undefined

      if (!p && !named && sessionProviders.length > 1) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><p>Choose a provider</p>')

        return
      }

      if (!p) {
        json(404, { detail: 'Unknown provider' })

        return
      }

      if (p.password) {
        redirect(res, '/login')

        return
      }

      stub.oidcReached.push(`native_authorize:${p.name}`)
      redirect(res, 'https://idp.example.invalid/authorize')

      return
    }

    json(404, { detail: 'Not Found' })
  }

  const server: Server = createServer(handle)
  const sockets = new WebSocketServer({ noServer: true })

  sockets.on('connection', socket => socket.send('hello'))

  /*
    uvicorn on an Upgrade request: `Upgrade: websocket` becomes a WebSocket
    scope, which only a WebSocket route answers (Starlette closes anything
    else with a 403). ANY other Upgrade value is served as plain HTTP — the
    very route handlers above, headers and all.
  */
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = req.url ?? '/'
    const route = pythonUnquote(target.split('?')[0] as string)

    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      const held: { status: number; headers: Record<string, string | string[]> } = { status: 200, headers: {} }
      const adapter = {
        setHeader: (name: string, value: string | string[]) => {
          held.headers[name] = value
        },
        writeHead: (status: number, headers: Record<string, string> = {}) => {
          held.status = status
          Object.assign(held.headers, headers)
        },
        end: (body = '') => {
          const lines = [`HTTP/1.1 ${String(held.status)} X`, 'connection: close']

          for (const [name, value] of Object.entries(held.headers)) {
            for (const one of Array.isArray(value) ? value : [value]) {
              lines.push(`${name}: ${one}`)
            }
          }

          lines.push(`content-length: ${String(Buffer.byteLength(body))}`)
          socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`)
        }
      }

      handle(req, adapter as unknown as ServerResponse)

      return
    }

    stub.targets.push(target)

    if (GATEWAY_WEBSOCKET_ROUTES.includes(route)) {
      sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req))

      return
    }

    if (route === '/api/ws-refused') {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nconnection: close\r\nset-cookie: leaked=1; Path=/\r\n' +
          'location: https://idp.example.invalid/authorize\r\ncontent-length: 6\r\n\r\nsecret'
      )

      return
    }

    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  stub.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  stub.close = () =>
    new Promise(resolve => {
      sockets.close()
      server.closeAllConnections()
      server.close(() => resolve())
    })

  return stub
}

/**
 * One request with its target sent EXACTLY as written — `fetch` would
 * normalise `..`, a backslash or a `#` before it ever left this process.
 */
function rawGet(base: string, target: string): Promise<{ status: number; location: string; body: string }> {
  const url = new URL(base)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method: 'GET', path: target, headers: { host: PUBLIC_HOST } },
      res => {
        let body = ''

        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), body })
        )
      }
    )

    req.on('error', reject)
    req.end()
  })
}

let staticDir: string

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-no-oidc-proxy-static-'))
  await mkdir(staticDir, { recursive: true })
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')
})

async function startWeb(stub: StubGateway, oidc = false): Promise<HermieWebServer> {
  return startHermieWeb({
    gatewayUrl: stub.url,
    port: 0,
    publicUrl: `http://${PUBLIC_HOST}`,
    staticDir,
    stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-web-no-oidc-proxy-state-')),
    version: '9.9.9',
    selfUpdate: false,
    oidc,
    env: {}
  })
}

/** An Upgrade request sent exactly as written, and whatever came back — a 101 or an ordinary answer. */
function rawUpgrade(
  base: string,
  target: string,
  upgrade: string
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const url = new URL(base)

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      method: 'GET',
      path: target,
      headers: {
        host: PUBLIC_HOST,
        connection: 'Upgrade',
        upgrade,
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
      }
    })

    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' })
    })
    req.on('response', res => {
      let body = ''

      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const NATIVE = 'code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&state=s'

describe('--no-oidc, against a gateway that decodes the path once', () => {
  let stub: StubGateway
  let web: HermieWebServer

  beforeAll(async () => {
    stub = await startStubGateway([
      { name: 'basic', password: true },
      { name: 'oidc', password: false }
    ])
    web = await startWeb(stub)
  })

  afterAll(async () => {
    await web.close()
    await stub.close()
  })

  afterEach(() => {
    stub.oidcReached.length = 0
  })

  /*
    Each of these reached an OIDC handler at the gateway through an earlier
    version of this proxy, which checked a decoded path and then forwarded
    that DECODED path — so the gateway decoded it a second time.
  */
  it.each([
    ['a double-encoded letter', '/auth/%256cogin?provider=oidc'],
    ['an encoded query separator', '/auth/login%3Fprovider=oidc'],
    ['an encoded query separator on the callback', '/auth/callback%3Fcode=c%26state=s'],
    [
      // The check read `provider=basic` from the real query; the gateway got
      // `?provider=oidc&?provider=basic…` and bound `oidc`.
      'an encoded query separator on native authorize',
      `/auth/native/authorize%3Fprovider=oidc%26?provider=basic&${NATIVE}`
    ],
    ['an encoded fragment', '/auth/login%23x?provider=oidc'],
    ['a double-encoded fragment', '/auth/login%2523x?provider=oidc']
  ])('refuses %s with a 400 and never reaches an OIDC handler', async (_label, target) => {
    const response = await rawGet(web.url, target)

    expect(response.status).toBe(400)
    expect(stub.oidcReached).toEqual([])
  })

  it.each([
    ['an encoded lowercase letter', '/auth/%6cogin?provider=oidc', 403],
    ['an encoded uppercase letter', '/auth/%6Cogin?provider=oidc', 403],
    ['a trailing slash', '/auth/login/?provider=oidc', 403],
    ['a doubled slash', '/auth//login?provider=oidc', 403],
    ['an encoded dot segment', '/auth/%2e/login?provider=oidc', 400],
    ['an encoded dot-dot segment', '/auth/x/%2e%2e/login?provider=oidc', 400],
    ['an encoded backslash', '/auth/%5clogin?provider=oidc', 400],
    ['an encoded slash', '/auth/%2Flogin?provider=oidc', 400],
    ['a raw backslash', '/auth\\login?provider=oidc', 400],
    ['an encoded callback', '/auth/%63allback?code=c&state=s', 403]
  ])('still refuses %s, and never reaches an OIDC handler', async (_label, target, status) => {
    const response = await rawGet(web.url, target)

    expect(response.status).toBe(status)
    expect(stub.oidcReached).toEqual([])
  })

  it('forwards the original path and query bytes, so the gateway decodes them exactly once', async () => {
    stub.targets.length = 0

    const response = await rawGet(web.url, '/api/some%2Dthing?b=%41&b=2&c')

    expect(response.status).toBe(404)
    expect(stub.targets).toEqual(['/api/some%2Dthing?b=%41&b=2&c'])
  })

  it('forwards an /api name holding an encoded %, ? or # as sent, rather than refusing it', async () => {
    stub.targets.length = 0

    const response = await rawGet(web.url, '/api/files/a%3Fb%23c%25d.txt?x=1')

    expect(response.status).toBe(404)
    expect(stub.targets).toEqual(['/api/files/a%3Fb%23c%25d.txt?x=1'])
  })

  /*
    Harmless straight into uvicorn, which never resolves a dot segment — but
    `--gateway` may name an edge proxy that does, decoding `%2e` or even
    decoding twice on the way. Under `/api`, a segment that is or could
    become `.`/`..`, `/` or `\\` is refused like anywhere else.
  */
  it.each([
    ['/%61pi/../auth/login?provider=oidc'],
    ['/api/%2e%2e/auth/login?provider=oidc'],
    ['/api/..%2fauth/login?provider=oidc'],
    ['/api/%2E%2E%2Fauth%2Flogin?provider=oidc'],
    ['/api/..%5cauth/login?provider=oidc'],
    ['/api/%252e%252e/auth/login?provider=oidc'],
    ['/api/%252f..%252fauth/login?provider=oidc'],
    ['/api/x/%2e/y']
  ])('refuses %s under /api too, for a normalising hop in between', async target => {
    stub.targets.length = 0

    const response = await rawGet(web.url, target)

    expect(response.status).toBe(400)
    expect(stub.targets).toEqual([])
  })

  it('refuses a provider named twice, since the gateway binds the LAST one', async () => {
    const response = await rawGet(web.url, `/auth/native/authorize?provider=basic&provider=oidc&${NATIVE}`)

    expect(response.status).toBe(400)
    expect(stub.oidcReached).toEqual([])
  })

  it('refuses a provider named twice through an encoded name too', async () => {
    const response = await rawGet(web.url, `/auth/native/authorize?provider=basic&%70rovider=oidc&${NATIVE}`)

    expect(response.status).toBe(400)
    expect(stub.oidcReached).toEqual([])
  })

  it('refuses native authorize for an OIDC provider', async () => {
    const response = await rawGet(web.url, `/auth/native/authorize?provider=oidc&${NATIVE}`)

    expect(response.status).toBe(403)
    expect(stub.oidcReached).toEqual([])
  })

  it('refuses an empty provider while the gateway has more than one to choose from', async () => {
    const response = await rawGet(web.url, `/auth/native/authorize?${NATIVE}`)

    expect(response.status).toBe(403)
  })

  it('asks the gateway for its providers at most once for a burst of native sign-ins', async () => {
    stub.targets.length = 0

    await Promise.all(
      Array.from({ length: 10 }, () => rawGet(web.url, `/auth/native/authorize?provider=basic&${NATIVE}`))
    )

    expect(stub.targets.filter(one => one === '/api/auth/providers').length).toBeLessThanOrEqual(1)
  })

  it('carries native sign-in with a password provider through to the gateway’s own form', async () => {
    const authorize = await rawGet(web.url, `/auth/native/authorize?provider=basic&${NATIVE}`)

    expect(authorize.status).toBe(302)
    expect(authorize.location).toBe('/login')

    const form = await rawGet(web.url, authorize.location)

    expect(form.status).toBe(200)
    expect(form.body).toContain('password-form')
    expect(stub.oidcReached).toEqual([])
  })
})

describe('--no-oidc, native sign-in with no provider named', () => {
  const stubs: StubGateway[] = []
  const webs: HermieWebServer[] = []

  afterAll(async () => {
    await Promise.all(webs.map(web => web.close()))
    await Promise.all(stubs.map(stub => stub.close()))
  })

  async function against(providers: StubProvider[]): Promise<{ stub: StubGateway; web: HermieWebServer }> {
    const stub = await startStubGateway(providers)
    const web = await startWeb(stub)

    stubs.push(stub)
    webs.push(web)

    return { stub, web }
  }

  it('lets it through when the gateway’s only provider takes a password — the gateway auto-selects that one', async () => {
    const { stub, web } = await against([{ name: 'basic', password: true }])
    const authorize = await rawGet(web.url, `/auth/native/authorize?${NATIVE}`)

    expect(authorize.status).toBe(302)
    expect(authorize.location).toBe('/login')
    expect((await rawGet(web.url, '/login')).status).toBe(200)
    expect(stub.oidcReached).toEqual([])
  })

  it('refuses it when the gateway’s only provider is an OIDC one', async () => {
    const { stub, web } = await against([{ name: 'oidc', password: false }])
    const authorize = await rawGet(web.url, `/auth/native/authorize?${NATIVE}`)

    expect(authorize.status).toBe(403)
    expect(stub.oidcReached).toEqual([])
  })

  it('refuses an explicitly empty provider the same way', async () => {
    const { stub, web } = await against([{ name: 'oidc', password: false }])
    const authorize = await rawGet(web.url, `/auth/native/authorize?provider=&${NATIVE}`)

    expect(authorize.status).toBe(403)
    expect(stub.oidcReached).toEqual([])
  })
})

describe('the provider probe', () => {
  it('sends the same Host the proxy does, so a gateway with a Host guard answers it', async () => {
    const stub = await startStubGateway([{ name: 'basic', password: true }], true)
    const web = await startWeb(stub)

    try {
      const config = (await (await fetch(`${web.url}/hermie/config.json`)).json()) as {
        providers: { name: string }[] | null
      }

      expect(config.providers?.map(p => p.name)).toEqual(['basic'])
      expect(stub.hosts.every(host => host === PUBLIC_HOST)).toBe(true)
    } finally {
      await web.close()
      await stub.close()
    }
  })
})

/*
  Node emits `upgrade` for ANY `Connection: Upgrade`, and uvicorn serves every
  Upgrade value but `websocket` as plain HTTP. An upgrade path that skipped the
  checks above therefore reached the gateway's OIDC routes with nothing in the
  way — and relayed the IdP redirect and the PKCE or session cookie back.
*/
describe.each([
  ['off', false],
  ['on', true]
])('upgrades, with OIDC %s', (_label, oidc) => {
  let stub: StubGateway
  let web: HermieWebServer

  beforeAll(async () => {
    stub = await startStubGateway([
      { name: 'basic', password: true },
      { name: 'oidc', password: false }
    ])
    web = await startWeb(stub, oidc)
  })

  afterAll(async () => {
    await web.close()
    await stub.close()
  })

  afterEach(() => {
    stub.oidcReached.length = 0
  })

  it.each([
    ['foo', '/auth/login?provider=oidc'],
    ['foo', '/auth/callback?code=c&state=s'],
    ['h2c', '/auth/login?provider=oidc'],
    ['foo', `/auth/native/authorize?provider=oidc&${NATIVE}`],
    ['foo', '/api/status']
  ])('refuses `Upgrade: %s` on %s with a 400 before it reaches the gateway', async (upgrade, target) => {
    const response = await rawUpgrade(web.url, target, upgrade)

    expect(response.status).toBe(400)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers.location).toBeUndefined()
    expect(stub.oidcReached).toEqual([])
  })

  it.each([['/auth/login?provider=oidc'], ['/auth/callback?code=c&state=s'], ['/login'], ['/auth/%6cogin']])(
    'refuses a WebSocket upgrade on %s — no gateway WebSocket lives outside /api',
    async target => {
      const response = await rawUpgrade(web.url, target, 'websocket')

      expect(response.status).toBe(404)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(stub.oidcReached).toEqual([])
    }
  )

  it('still upgrades a real WebSocket path, target forwarded as sent', async () => {
    stub.targets.length = 0

    const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}/api/ws?x=%41`)
    const first = await new Promise<string>((resolve, reject) => {
      socket.on('message', data => resolve(String(data)))
      socket.on('error', reject)
    })

    socket.close()
    expect(first).toBe('hello')
    expect(stub.targets).toEqual(oidc ? ['/api/ws?x=%41'] : ['/api/ws?x=%41'])
  })

  it.each(GATEWAY_WEBSOCKET_ROUTES.map(route => [route]))('upgrades the gateway WebSocket at %s', async route => {
    const socket = new WebSocket(`${web.url.replace('http://', 'ws://')}${route}`)
    const first = await new Promise<string>((resolve, reject) => {
      socket.on('message', data => resolve(String(data)))
      socket.on('error', reject)
    })

    socket.close()
    expect(first).toBe('hello')
  })

  it('accepts the Upgrade token in any case', async () => {
    const response = await rawUpgrade(web.url, '/api/ws', 'WebSocket')

    expect(response.status).toBe(101)
  })

  it('relays a refused upgrade’s status, and none of its headers or body', async () => {
    const response = await rawUpgrade(web.url, '/api/ws-refused', 'websocket')

    expect(response.status).toBe(403)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers.location).toBeUndefined()
    expect(response.body).not.toContain('secret')
  })
})
