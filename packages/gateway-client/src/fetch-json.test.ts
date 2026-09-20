/**
 * Which shapes the transport accepts, and where an object is still the contract.
 *
 * `GatewayHttp.request` used to run EVERY response body through
 * `parseJsonObject`, so `GET /api/cron/jobs` — which `hermes serve` answers with
 * a bare array — failed before its reader ever saw it. The crons list could not
 * load from any gateway at all, and the reader had a comment saying it handled
 * both shapes the whole time.
 *
 * The fix has two halves and both are load-bearing. The transport asks only
 * whether the body is JSON; and the three handshakes where an object really IS
 * the protocol keep asking for one, because an array arriving THERE means the
 * address is not a Hermes gateway and saying so early is the entire point of
 * that check. This file pins the second half as hard as the first: a future
 * tidy-up that "unifies" the two parsers would put the security check back in
 * the bin.
 */
import { describe, expect, it } from 'vitest'

import type { CredentialProvider } from './credentials'
import { exchangeCode, refreshTokens } from './native-auth'
import {
  looksLikeCertificateFailure,
  looksLikeTlsFailure,
  parseJsonBody,
  parseJsonObject,
  type FetchLike
} from './fetch-json'
import { GatewayHttp } from './http'
import { probeGateway } from './probe'
import type { GatewayError } from './types'

const BASE = 'http://gateway.test'

/** A `fetch` that answers every call with one body. */
function answering(text: string, status = 200): FetchLike {
  return (async () =>
    new Response(text, { status, headers: { 'content-type': 'application/json' } })) as unknown as FetchLike
}

/** Credentials that carry nothing: these routes are unauthenticated here. */
const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

const httpWith = (fetchImpl: FetchLike) => new GatewayHttp({ baseUrl: BASE, credentials: anonymous, fetchImpl })

/**
 * The two TLS predicates. They are not the same question, and the second one
 * decides whether a scheme-less address may be retried over http.
 */
describe('classifying a failed secure connection', () => {
  it.each([
    // Measured on the iOS 27 simulator: no error code in the message at all.
    'A TLS error caused the secure connection to fail.',
    'javax.net.ssl.SSLException: Unable to parse TLS packet header',
    'unable to verify the first certificate',
    'Error code=-1200'
  ])('reads %s as a TLS failure', message => {
    expect(looksLikeTlsFailure(message)).toBe(true)
  })

  it('does not read an ordinary connection failure as one', () => {
    expect(looksLikeTlsFailure('connect ECONNREFUSED 10.0.0.4:443')).toBe(false)
    expect(looksLikeTlsFailure('getaddrinfo ENOTFOUND hermes.test')).toBe(false)
  })

  it.each([
    'unable to verify the first certificate',
    'The certificate for this server is invalid',
    'Hostname/IP does not match certificate altnames',
    'self signed certificate in certificate chain',
    'NSURLErrorDomain Code=-1202'
  ])('reads %s as a CERTIFICATE failure — there is a real https server there', message => {
    expect(looksLikeCertificateFailure(message)).toBe(true)
  })

  it.each([
    'A TLS error caused the secure connection to fail.',
    'javax.net.ssl.SSLException: Unable to parse TLS packet header',
    'write EPROTO ... wrong version number',
    'NSURLErrorDomain Code=-1200'
  ])('does not read %s as one — nothing there spoke TLS', message => {
    expect(looksLikeCertificateFailure(message)).toBe(false)
  })
})

describe('parseJsonBody', () => {
  it('accepts an array, which is what the cron list answers with', () => {
    expect(parseJsonBody('[{"id":"job-1"}]', BASE, 'protocol')).toEqual([{ id: 'job-1' }])
  })

  it('accepts an object, a string, a number and null just as readily', () => {
    expect(parseJsonBody('{"ok":true}', BASE, 'protocol')).toEqual({ ok: true })
    expect(parseJsonBody('"done"', BASE, 'protocol')).toBe('done')
    expect(parseJsonBody('7', BASE, 'protocol')).toBe(7)
    expect(parseJsonBody('null', BASE, 'protocol')).toBeNull()
  })

  it('still refuses a body that is not JSON at all', () => {
    expect(() => parseJsonBody('<html>nope</html>', BASE, 'protocol')).toThrow(/not JSON/u)
  })
})

describe('parseJsonObject', () => {
  it('refuses an array, which is the check the handshakes need', () => {
    expect(() => parseJsonObject('[1,2,3]', BASE, 'not_hermes')).toThrow(/not an object/u)
  })

  it('refuses the other non-objects too, including null', () => {
    for (const body of ['null', '"done"', '7', 'true']) {
      expect(() => parseJsonObject(body, BASE, 'protocol')).toThrow(/not an object/u)
    }
  })

  it('carries the kind it was given, so a probe can say "not a Hermes gateway"', () => {
    try {
      parseJsonObject('[]', BASE, 'not_hermes')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as GatewayError).kind).toBe('not_hermes')
    }
  })
})

describe('a generic REST call through GatewayHttp', () => {
  it('hands an array body to the caller instead of throwing at it', async () => {
    const jobs = await httpWith(answering('[{"id":"job-1"},{"id":"job-2"}]')).get<{ id: string }[]>(
      '/api/cron/jobs?profile=all'
    )

    expect(jobs).toHaveLength(2)
    expect(jobs[0]?.id).toBe('job-1')
  })

  it('hands an object body over unchanged', async () => {
    expect(await httpWith(answering('{"runs":[],"limit":20}')).get('/api/cron/jobs/job-1/runs')).toEqual({
      runs: [],
      limit: 20
    })
  })

  it('answers undefined for an empty body rather than a parse failure', async () => {
    expect(await httpWith(answering('')).delete('/api/cron/jobs/job-1')).toBeUndefined()
  })

  it('still refuses a body that is not JSON', async () => {
    await expect(httpWith(answering('<html>proxy error</html>')).get('/api/cron/jobs')).rejects.toThrow(/not JSON/u)
  })
})

/**
 * The three places an object is the protocol.
 *
 * Each is a handshake that decides whether this address is a Hermes gateway at
 * all, or that mints something the socket then depends on. An array there is a
 * proxy, a captive portal or somebody else's API, and the early, specific
 * failure is what the wizard shows the user.
 */
describe('the handshakes that still require an object', () => {
  it('the status probe refuses an array', async () => {
    await expect(probeGateway(BASE, {}, answering('[]'))).rejects.toThrow(/not an object/u)
  })

  it('the provider list refuses an array', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1

      // The status answers a gated gateway; the provider list is the array.
      return call === 1 ? new Response('{"auth_required":true}', { status: 200 }) : new Response('[]', { status: 200 })
    }) as unknown as FetchLike

    await expect(probeGateway(BASE, {}, fetchImpl)).rejects.toThrow(/not an object/u)
  })

  it('the WebSocket ticket refuses an array', async () => {
    await expect(httpWith(answering('[]')).wsTicket()).rejects.toThrow(/without a ticket/u)
  })

  it('the native token exchange refuses an array', async () => {
    await expect(exchangeCode(BASE, { code: 'c', verifier: 'v' }, { fetchImpl: answering('[]') })).rejects.toThrow(
      /not an object/u
    )
  })

  it('the native refresh refuses an array', async () => {
    await expect(
      refreshTokens(BASE, { refreshToken: 'r', provider: 'self-hosted' }, { fetchImpl: answering('[]') })
    ).rejects.toThrow(/not an object/u)
  })
})
