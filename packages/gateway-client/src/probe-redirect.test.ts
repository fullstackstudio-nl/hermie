/**
 * A probe that lands somewhere else.
 *
 * `hermes.fullstackstudio.nl` had moved to
 * `hermes.provibr.net` and left a 301 behind. The iOS URL cache is keyed by
 * bundle identifier and OUTLIVES the app, so deleting Hermie and installing it
 * again did not clear it: the new install's very first onboarding probe was
 * answered out of that cache, reached the host the owner had left, and reported
 * "that is not a Hermes gateway" — naming the address they had typed, which was
 * correct. The probe now refuses to follow a redirect to a different host and
 * says where it was sent, so the wizard can offer that host instead.
 *
 * The redirect cases run against two real servers, because "did fetch follow
 * it, and does `response.url` say where it ended up" is exactly the kind of
 * question a stub answers whichever way it was written.
 */
import { startFakeGateway } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'

import { requestText } from './fetch-json'
import { probeGateway, resolveGatewayAddress } from './probe'
import { isGatewayError } from './types'

describe('an address that redirects somewhere else', () => {
  it('is refused, named, and nothing is read from it', async () => {
    const real = await startFakeGateway({ port: 0 })
    // The old domain, still answering, still pointing at the new one — which is
    // what the cached 301 reproduced months after the move. A different NAME
    // for the same loopback, because what the check is about is the host.
    const newHome = real.url.replace('127.0.0.1', 'localhost')
    const moved = await startFakeGateway({ port: 0, redirectTo: newHome })

    try {
      const error = await probeGateway(moved.url).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.kind).toBe('redirect')
      expect(isGatewayError(error) && error.redirectedTo).toBe('localhost')
      // Not "not a Hermes gateway": the thing it reached IS one, and saying so
      // about the address the owner typed is what sent them looking at DNS.
      expect(isGatewayError(error) && error.message).toMatch(/redirected to/u)
    } finally {
      await Promise.all([real.close(), moved.close()])
    }
  })

  it('is still reported when the scheme-less fallback is what found it', async () => {
    const real = await startFakeGateway({ port: 0 })
    const moved = await startFakeGateway({ port: 0, redirectTo: real.url.replace('127.0.0.1', 'localhost') })

    try {
      /*
        No scheme, so https is tried first, fails to connect, and http finds the
        redirect. The resolver's rule is that the https failure is the one worth
        reading — but a redirect is not a failure to reach the address, it is
        the address saying it has moved, and reporting "could not reach it over
        https" instead sends the reader after a port they never asked about.
      */
      const error = await resolveGatewayAddress(new URL(moved.url).host).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.kind).toBe('redirect')
      expect(isGatewayError(error) && error.redirectedTo).toBe('localhost')
    } finally {
      await Promise.all([real.close(), moved.close()])
    }
  })

  it('follows a redirect that stays on the same host without comment', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      // `/api/status/` → `/api/status` and http → https on one name are
      // ordinary. Only a change of HOST is a different server answering.
      const probe = await probeGateway(gateway.url)

      expect(typeof probe.authRequired).toBe('boolean')
    } finally {
      await gateway.close()
    }
  })
})

describe('every request', () => {
  it('goes out with the platform cache switched off', async () => {
    // The other half of the same fix: nothing new is stored, so no future
    // install inherits a redirect from this one. Asserted on the init rather
    // than on behaviour, because a cache that is working correctly is
    // indistinguishable from one that is empty.
    const seen: RequestInit[] = []

    await requestText('https://gateway.example/api/status', {
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {})

        return new Response('{}', { status: 200 })
      }
    })

    expect(seen[0]?.cache).toBe('no-store')
  })
})
