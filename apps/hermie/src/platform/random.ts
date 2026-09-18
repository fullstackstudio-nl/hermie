import { GatewayError, type RandomBytes } from '@hermie/gateway-client'
import * as Crypto from 'expo-crypto'

/**
 * Cryptographically strong random bytes for PKCE.
 *
 * `expo-crypto` is the intended source on every platform — its podspec declares
 * macOS, so it links there too. "Links and compiles" is not "works", though, so
 * the module is probed once at first use and the runtime's own
 * `crypto.getRandomValues` is used if the probe throws. If neither exists the
 * app refuses to start a sign-in rather than inventing a verifier out of
 * `Math.random`, which would make the PKCE challenge decorative.
 */

export type EntropySource = 'expo-crypto' | 'web-crypto'

let resolved: { source: EntropySource; bytes: RandomBytes } | null = null

function webCryptoBytes(): RandomBytes | null {
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto

  if (!webcrypto?.getRandomValues) {
    return null
  }

  return length => webcrypto.getRandomValues!(new Uint8Array(length))
}

function resolveSource(): { source: EntropySource; bytes: RandomBytes } {
  if (resolved) {
    return resolved
  }

  try {
    const probe = Crypto.getRandomBytes(1)

    if (probe instanceof Uint8Array && probe.length === 1) {
      resolved = { source: 'expo-crypto', bytes: length => Crypto.getRandomBytes(length) }

      return resolved
    }
  } catch {
    // Falls through to the runtime's own source below.
  }

  const web = webCryptoBytes()

  if (web) {
    resolved = { source: 'web-crypto', bytes: web }

    return resolved
  }

  throw new GatewayError(
    'config',
    'This device offers no secure source of randomness, so Hermie cannot start a sign-in safely.'
  )
}

export const randomBytes: RandomBytes = length => resolveSource().bytes(length)

/** Which source was chosen. Reported on the developer connection screen. */
export function entropySource(): EntropySource | 'unavailable' {
  try {
    return resolveSource().source
  } catch {
    return 'unavailable'
  }
}
