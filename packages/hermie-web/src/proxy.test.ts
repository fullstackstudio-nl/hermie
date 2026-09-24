import { createServer, type IncomingMessage, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { hostPinnedFetch, isSecureRequest, rewriteSetCookie, upstreamHeaders } from './proxy'

/**
 * The two pieces that decide what the gateway is told about the browser, and
 * what the browser is allowed to keep. Everything here is about ONE question —
 * did the browser arrive over https — because Hermie Web itself never speaks it
 * and therefore cannot see the answer on its own socket.
 */

const TARGET = { gatewayUrl: 'http://127.0.0.1:9119', publicUrl: 'https://hermes.example.com' }

const request = (headers: Record<string, string>, encrypted = false) =>
  ({
    headers: { host: 'hermes.example.com:9443', ...headers },
    socket: { encrypted, remoteAddress: '127.0.0.1' }
  }) as unknown as IncomingMessage

describe('the scheme the browser actually used', () => {
  it('is http when nothing in front said otherwise', () => {
    expect(isSecureRequest(request({}))).toBe(false)
    expect(upstreamHeaders(request({}), TARGET)['x-forwarded-proto']).toBe('http')
  })

  it('is https when the reverse proxy says so, though our own socket is plain', () => {
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'https' }))).toBe(true)
    expect(upstreamHeaders(request({ 'x-forwarded-proto': 'https' }), TARGET)['x-forwarded-proto']).toBe('https')
  })

  it('reads the first hop of a chain, and ignores the case it is written in', () => {
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'HTTPS, http' }))).toBe(true)
    expect(isSecureRequest(request({ 'x-forwarded-proto': 'http, https' }))).toBe(false)
  })

  it('needs no header at all when the socket is genuinely TLS', () => {
    expect(isSecureRequest(request({}, true))).toBe(true)
  })

  it('still rewrites Host and Origin to the gateway’s public URL', () => {
    const headers = upstreamHeaders(request({ origin: 'https://hermes.example.com:9443' }), TARGET)

    expect(headers.host).toBe('hermes.example.com')
    expect(headers.origin).toBe('https://hermes.example.com')
    // The address the browser really used is not lost; it travels beside it.
    expect(headers['x-forwarded-host']).toBe('hermes.example.com:9443')
  })
})

describe('the cookies that come back', () => {
  const session = '__Host-hermes_session_pkce=abc; HttpOnly; Max-Age=600; Path=/; SameSite=none; Secure'

  it('keeps Secure and SameSite=None for a browser on https', () => {
    expect(rewriteSetCookie(session, true)).toBe(session)
  })

  it('drops Secure for a browser on plain http, where it would be discarded', () => {
    const rewritten = rewriteSetCookie(session, false)

    expect(rewritten.toLowerCase()).not.toContain('secure')
    // SameSite=None without Secure is refused outright, so it has to become Lax.
    expect(rewritten).toContain('SameSite=Lax')
  })

  it('always drops Domain, whichever scheme it was', () => {
    for (const secure of [true, false]) {
      expect(rewriteSetCookie('a=b; Domain=hermes.example.com; Path=/', secure).toLowerCase()).not.toContain('domain=')
    }
  })
})

describe('hostPinnedFetch', () => {
  async function serve(listener: RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(listener)

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    return {
      url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      close: () =>
        new Promise(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    }
  }

  it('sends the Host it was given, and answers the body', async () => {
    const server = await serve((req, res) => res.end(JSON.stringify({ host: req.headers.host })))

    try {
      const response = await hostPinnedFetch('hermes.example.test')(`${server.url}/api/status`)

      expect(await response.json()).toEqual({ host: 'hermes.example.test' })
    } finally {
      await server.close()
    }
  })

  it('refuses an answer larger than a megabyte', async () => {
    const server = await serve((_req, res) => {
      res.write(Buffer.alloc(768 * 1024))
      res.end(Buffer.alloc(768 * 1024))
    })

    try {
      await expect(hostPinnedFetch('h')(`${server.url}/`)).rejects.toThrow(/too large/)
    } finally {
      await server.close()
    }
  })

  it('settles, rather than hangs, when the answer is cut off part-way', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '100' })
      res.write('partial')
      setTimeout(() => res.socket?.destroy(), 10)
    })

    try {
      await expect(hostPinnedFetch('h')(`${server.url}/`)).rejects.toThrow()
    } finally {
      await server.close()
    }
  })
})
