/**
 * The provider's signing keys, and the JWKS a relying party reads them from.
 *
 * **RS256, and the choice is the gateway's rather than ours.** Upstream's
 * relying party (`plugins/dashboard_auth/self_hosted/__init__.py`) verifies the
 * ID token against a fixed algorithm allow-list:
 *
 * ```python
 * _ALLOWED_ID_TOKEN_ALGS = ("RS256", "ES256", "RS384", "RS512", "ES384", "ES512")
 * ```
 *
 * ES256 would do and is half the bytes, but RS256 is the OIDC default, is what
 * every other relying party an operator might later point at this issuer
 * accepts without being configured, and is first on that list. A smaller
 * signature is not worth a second compatibility question.
 *
 * HS256 is deliberately impossible here: there is no shared secret in this
 * design, and upstream excludes it by name as an algorithm-confusion footgun.
 *
 * ## Rotation, and why the old key stays
 *
 * A rotation that removed the old public key would invalidate every token
 * already in somebody's cookie jar — which is the gateway's whole session, held
 * as the ID token itself (`Session.access_token` upstream). So a rotation
 * PROMOTES a new key to signing and keeps the previous one in the JWKS until
 * every token it signed has expired. `retireBefore` is that moment, and
 * `prunedKeys` is what drops it once it passes.
 *
 * Upstream reads the JWKS through `PyJWKClient(..., cache_keys=True,
 * lifespan=300)` and selects on `kid`, so two things are load-bearing: every
 * key carries a `kid`, and every token header names the `kid` it was signed
 * with. Five minutes is also the shortest a rotation can take to be seen, which
 * is why nothing here tries to make a rotation instant.
 *
 * Zero runtime dependencies (ADR-0015): `node:crypto` generates the pair,
 * exports the JWK, and computes the RFC 7638 thumbprint that names it.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

/** The one signing algorithm this provider offers. See the note above. */
export const SIGNING_ALG = 'RS256'

/** 2048 bits: the floor every relying party accepts, and what RS256 means in practice. */
export const RSA_MODULUS_BITS = 2048

/** A public JWK, as it appears in the JWKS document. */
export interface PublicJwk {
  kty: 'RSA'
  use: 'sig'
  alg: typeof SIGNING_ALG
  kid: string
  n: string
  e: string
}

/**
 * One key pair as it is stored.
 *
 * The private half is PKCS#8 PEM rather than a JWK, because that is the form
 * `createPrivateKey` takes back without a second conversion, and because a
 * reader who opens the state file should be in no doubt about what they are
 * looking at.
 */
export interface StoredKey {
  kid: string
  privatePem: string
  publicJwk: PublicJwk
  /** Unix seconds this key was generated. */
  createdAt: number
  /**
   * Unix seconds after which this key may leave the JWKS, or `0` for the
   * current signing key.
   *
   * Set when the key is retired, to "now plus the longest thing it signed".
   */
  retireBefore: number
}

/**
 * The RFC 7638 thumbprint of an RSA public JWK, base64url.
 *
 * The members and their order are fixed by the RFC — `e`, `kty`, `n`, no
 * whitespace — so two implementations naming the same key agree. Using the
 * thumbprint rather than a random string means a `kid` cannot collide and
 * cannot be forged into pointing at a different key.
 */
export function jwkThumbprint(jwk: { e: string; n: string }): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })

  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/** Generate a fresh signing key. Called on first enable and on every rotation. */
export function generateKey(now: number = Math.floor(Date.now() / 1000)): StoredKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: RSA_MODULUS_BITS })
  const raw = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string }

  /* c8 ignore next 3 -- Node always answers both for an RSA public key; this is
     a type narrowing rather than a case that happens. */
  if (!raw.n || !raw.e) {
    throw new Error('node:crypto exported an RSA public key without n and e')
  }

  const kid = jwkThumbprint({ n: raw.n, e: raw.e })

  return {
    kid,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicJwk: { kty: 'RSA', use: 'sig', alg: SIGNING_ALG, kid, n: raw.n, e: raw.e },
    createdAt: now,
    retireBefore: 0
  }
}

/** The `KeyObject` for signing with this key. */
export function privateKeyOf(key: StoredKey): KeyObject {
  return createPrivateKey(key.privatePem)
}

/** The `KeyObject` for verifying a token this key signed. */
export function publicKeyOf(key: StoredKey): KeyObject {
  // Spread into a plain object: `PublicJwk` is a closed interface and
  // `JsonWebKey` wants an index signature, which is a typing detail rather than
  // a difference in the bytes.
  return createPublicKey({ key: { ...key.publicJwk }, format: 'jwk' })
}

/**
 * The JWKS document: the signing key first, then everything not yet retired.
 *
 * Order matters only for a client that ignores `kid` and tries keys in turn —
 * which upstream's does not — but putting the current key first costs nothing
 * and is what such a client would need.
 */
export function jwksDocument(keys: readonly StoredKey[]): { keys: PublicJwk[] } {
  return { keys: keys.map(key => key.publicJwk) }
}

/**
 * Rotate: a new signing key in front, the old one kept behind it until
 * `holdSeconds` have passed.
 *
 * `holdSeconds` is the caller's longest token lifetime, not a guess made here —
 * the module that knows how long an ID token lives is the one that issues it.
 */
export function rotatedKeys(
  keys: readonly StoredKey[],
  options: { now?: number; holdSeconds: number; generate?: (now: number) => StoredKey }
): StoredKey[] {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const fresh = (options.generate ?? generateKey)(now)
  const retired = keys.map(key => (key.retireBefore ? key : { ...key, retireBefore: now + options.holdSeconds }))

  return prunedKeys([fresh, ...retired], now)
}

/**
 * Drop keys whose last token has expired.
 *
 * The signing key (`retireBefore === 0`) is never a candidate, and neither is
 * the last key standing — a JWKS with no keys in it is a provider that has
 * locked everybody out, which is not a state a clock should be able to reach.
 */
export function prunedKeys(keys: readonly StoredKey[], now: number = Math.floor(Date.now() / 1000)): StoredKey[] {
  const kept = keys.filter(key => !key.retireBefore || key.retireBefore > now)

  return kept.length ? kept : keys.slice(0, 1)
}

/** The key a token should be signed with: the one that has not been retired. */
export function signingKey(keys: readonly StoredKey[]): StoredKey | null {
  return keys.find(key => !key.retireBefore) ?? keys[0] ?? null
}

/** The key a `kid` names, or `null` when this issuer never had it. */
export function keyForKid(keys: readonly StoredKey[], kid: string): StoredKey | null {
  return keys.find(key => key.kid === kid) ?? null
}
