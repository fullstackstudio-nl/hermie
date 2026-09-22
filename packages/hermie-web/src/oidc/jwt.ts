/**
 * Compact JWS, signed and verified with `node:crypto` alone.
 *
 * ADR-0015 forbids a runtime dependency in this package, so `jose` and
 * `jsonwebtoken` are both out. What is left is small enough to be read in one
 * sitting, which is the right size for the code that mints an identity: a
 * header and a payload, base64url, joined by dots, signed with
 * RSASSA-PKCS1-v1_5 over SHA-256 — which is all RS256 is.
 *
 * ## What the verifier is for
 *
 * It is NOT on the path that matters. The relying party that counts is
 * upstream's PyJWT, and it verifies what this file signs; nothing here is
 * asked to check a token from anywhere else. The verifier exists so that the
 * provider can read back its own access token on `/oidc/userinfo` without a
 * server-side token table, and so the admin page's test sign-in can prove that
 * what was signed actually validates against the published JWKS rather than
 * asserting it.
 *
 * ## The two things a hand-written verifier gets wrong
 *
 *  - **Trusting `alg` from the header.** The header's algorithm is the
 *    attacker's field, so it is COMPARED against the one algorithm this issuer
 *    uses and never used to select a verification routine. `none` and HS256
 *    fail on that comparison before a key is looked at.
 *  - **Reading claims off an unverified token.** `verifyJwt` returns claims
 *    only after the signature and the registered claims have passed.
 *    `unverifiedHeader` exists purely to read the `kid` that says which key to
 *    verify WITH, which is the one thing that has to be read first, and its
 *    name says so.
 */
import { createHash, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'

import { keyForKid, privateKeyOf, publicKeyOf, SIGNING_ALG, type StoredKey } from './keys'

/** Registered and provider claims, as they travel. */
export type JwtClaims = Record<string, unknown> & {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/**
 * Sign a claim set with the given key.
 *
 * `typ` is a parameter because the two tokens this provider mints want
 * different ones: an ID token is a plain `JWT`, and an access token is
 * `at+jwt` (RFC 9068) so that anything which ever inspects one can tell at a
 * glance it is not an identity assertion. Upstream reads neither — it treats
 * the access token as opaque — so this is for everybody else.
 */
export function signJwt(claims: JwtClaims, key: StoredKey, typ: 'JWT' | 'at+jwt' = 'JWT'): string {
  const header = { alg: SIGNING_ALG, typ, kid: key.kid }
  const signingInput = `${encode(header)}.${encode(claims)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), privateKeyOf(key))

  return `${signingInput}.${signature.toString('base64url')}`
}

/**
 * The header of a token nothing has verified yet.
 *
 * Only ever used to read `kid`, which has to be read before a key can be
 * chosen. Everything else in the header is ignored here and re-checked in
 * `verifyJwt` against what this issuer actually does.
 */
export function unverifiedHeader(token: string): { alg?: string; kid?: string; typ?: string } | null {
  const part = token.split('.')[0]

  if (!part) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { alg?: string }) : null
  } catch {
    return null
  }
}

export interface VerifyOptions {
  issuer: string
  audience: string
  /** Seconds of tolerance for a clock that is not quite ours. */
  clockSkewSeconds?: number
  now?: number
  /** Refuse a token whose `typ` is not this one, when given. */
  typ?: string
}

/**
 * Verify a compact JWS against this issuer's keys and return its claims.
 *
 * The claim checks are deliberately the same set upstream's PyJWT requires —
 * `exp`, `iat`, `aud`, `iss`, `sub` — so a token that passes here is a token
 * that passes there. A test that only checked our own verifier would prove
 * nothing about the relying party; making the two agree on the required set is
 * what gives it meaning.
 *
 * Throws with a reason rather than answering `null`, because every caller wants
 * to say WHICH step failed: the self-test prints it, and userinfo turns it into
 * one `invalid_token`.
 */
export function verifyJwt(token: string, keys: readonly StoredKey[], options: VerifyOptions): JwtClaims {
  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new Error('that is not a compact JWS')
  }

  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]
  const header = unverifiedHeader(token)

  if (!header) {
    throw new Error('the token header is not JSON')
  }

  // The header's algorithm is compared, never obeyed. This is the line that
  // makes `alg: none` and an HS256 confusion attack both a plain mismatch.
  if (header.alg !== SIGNING_ALG) {
    throw new Error(`the token is signed with ${String(header.alg)}, and this issuer only signs ${SIGNING_ALG}`)
  }

  if (options.typ && header.typ !== options.typ) {
    throw new Error(`the token is a ${String(header.typ)}, not a ${options.typ}`)
  }

  const key = header.kid ? keyForKid(keys, header.kid) : null

  if (!key) {
    throw new Error(`no key in this issuer's JWKS has kid ${String(header.kid)}`)
  }

  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii'),
    publicKeyOf(key),
    Buffer.from(rawSignature, 'base64url')
  )

  if (!ok) {
    throw new Error('the signature does not match')
  }

  let claims: JwtClaims

  try {
    claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as JwtClaims
  } catch {
    throw new Error('the token payload is not JSON')
  }

  // The same five PyJWT is told to require. A token missing one of these is one
  // upstream would refuse, so refusing it here keeps the two ends honest.
  for (const claim of ['iss', 'sub', 'aud', 'exp', 'iat'] as const) {
    if (claims[claim] === undefined) {
      throw new Error(`the token has no ${claim} claim`)
    }
  }

  if (claims.iss !== options.issuer) {
    throw new Error(`the token was issued by ${String(claims.iss)}, not ${options.issuer}`)
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]

  if (!audiences.includes(options.audience)) {
    throw new Error(`the token is for ${JSON.stringify(claims.aud)}, not ${options.audience}`)
  }

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const skew = options.clockSkewSeconds ?? 60

  if (typeof claims.exp !== 'number' || claims.exp + skew <= now) {
    throw new Error('the token has expired')
  }

  if (typeof claims.iat !== 'number' || claims.iat - skew > now) {
    throw new Error('the token was issued in the future')
  }

  return claims
}

/**
 * A constant-time compare of two secrets that arrived as strings.
 *
 * Hashing first rather than comparing the bytes: `timingSafeEqual` throws on a
 * length mismatch, and answering "wrong length" quickly is itself a fact about
 * the secret. Two SHA-256 digests are always the same length, so the compare
 * happens for every input and the only thing that leaks is whether they match.
 */
export function secretsMatch(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()

  return timingSafeEqual(a, b)
}

/** The stored form of an opaque token: a digest, so the file holds no credential. */
export function tokenDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}
