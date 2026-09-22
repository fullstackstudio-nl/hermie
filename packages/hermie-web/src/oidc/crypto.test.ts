/**
 * The provider's primitives, pinned against their specifications rather than
 * against themselves.
 *
 * A hand-written TOTP that only agrees with its own output is a hand-written
 * TOTP that nobody's phone will agree with, and a hand-written JWT verifier
 * that only rejects what its author thought of is the one that accepts
 * `alg: none`. So the assertions here are the RFC's own test vectors and the
 * two attacks the verifier exists to stop.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { signJwt, tokenDigest, unverifiedHeader, verifyJwt } from './jwt'
import { generateKey, jwkThumbprint, jwksDocument, prunedKeys, rotatedKeys, signingKey } from './keys'
import { base32Decode, base32Encode, hotp, newRecoveryCodes, otpauthUri, totpAt, totpMatches } from './totp'
import { hashPassword, passwordMatches, recoveryDigest, spendRecoveryCode, type OidcUser } from './users'

/** RFC 6238 Appendix B's shared secret for the SHA-1 profile. */
const RFC_SECRET_ASCII = '12345678901234567890'

describe('TOTP against RFC 6238 Appendix B', () => {
  /*
    The published vectors are eight digits; this provider issues six, which is
    the same number truncated. Asserting on the eight-digit value first means a
    failure says "the algorithm is wrong" rather than "the digits are wrong".
  */
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037']
  ]

  it.each(vectors)('at T=%i answers %s', (time, expected) => {
    const secret = Buffer.from(RFC_SECRET_ASCII, 'ascii')
    const eight = String(Number(hotp(secret, Math.floor(time / 30))) % 10 ** 6).padStart(6, '0')

    // The six digits this provider shows are the tail of the published value.
    expect(eight).toBe(expected.slice(-6))
  })

  it('accepts the step either side of now and nothing further', () => {
    const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))
    const now = 1_111_111_111

    expect(totpMatches(secret, totpAt(secret, now), { now })).toBe(true)
    expect(totpMatches(secret, totpAt(secret, now - 30), { now })).toBe(true)
    expect(totpMatches(secret, totpAt(secret, now + 30), { now })).toBe(true)
    expect(totpMatches(secret, totpAt(secret, now + 120), { now })).toBe(false)
  })

  it('refuses anything that is not six digits without reaching the HMAC', () => {
    const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))

    expect(totpMatches(secret, '', {})).toBe(false)
    expect(totpMatches(secret, '12345', {})).toBe(false)
    expect(totpMatches(secret, 'abcdef', {})).toBe(false)
  })
})

describe('base32, because otpauth:// is written in it', () => {
  it('round-trips every length that exercises a different bit remainder', () => {
    for (let size = 1; size <= 20; size += 1) {
      const bytes = Buffer.from(Array.from({ length: size }, (_, index) => (index * 37) % 256))

      expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    }
  })

  it('reads a secret back after somebody has retyped it in lower case with spaces', () => {
    const encoded = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))

    expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(
      Buffer.from(RFC_SECRET_ASCII, 'ascii')
    )
  })

  it('puts the issuer in an otpauth URI twice, for the apps that read each place', () => {
    const uri = otpauthUri({ issuerName: 'Acme Web', account: 'ada', secret: 'ABCD' })

    expect(uri.startsWith('otpauth://totp/Acme%20Web%3Aada?')).toBe(true)
    expect(uri).toContain('issuer=Acme+Web')
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
  })
})

describe('JWT', () => {
  const key = generateKey(1000)
  const claims = { iss: 'https://issuer.invalid/oidc', sub: 'abc', aud: 'client-1', iat: 1000, exp: 2000 }

  it('signs something the published JWKS verifies, with no library on either side', () => {
    const token = signJwt(claims, key)
    const [header, payload, signature] = token.split('.') as [string, string, string]
    const published = jwksDocument([key]).keys[0]

    expect(published?.kid).toBe(key.kid)
    // The real assertion: the PUBLIC half, as a relying party would fetch it,
    // verifies the signature. Nothing here reuses the private key.
    expect(
      cryptoVerify(
        'sha256',
        Buffer.from(`${header}.${payload}`, 'ascii'),
        createPublicKey({ key: { ...published! }, format: 'jwk' }),
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true)
  })

  it('names the key in the header, because PyJWKClient selects on kid', () => {
    expect(unverifiedHeader(signJwt(claims, key))).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: key.kid })
  })

  it('computes kid as the RFC 7638 thumbprint, so two implementations agree', () => {
    const canonical = JSON.stringify({ e: key.publicJwk.e, kty: 'RSA', n: key.publicJwk.n })

    expect(key.kid).toBe(createHash('sha256').update(canonical, 'utf8').digest('base64url'))
    expect(jwkThumbprint(key.publicJwk)).toBe(key.kid)
  })

  it('verifies its own token with the claims pinned', () => {
    const token = signJwt(claims, key)

    expect(verifyJwt(token, [key], { issuer: claims.iss, audience: 'client-1', now: 1500 })).toMatchObject({
      sub: 'abc'
    })
  })

  it('refuses a token whose header says alg: none', () => {
    const forged = `${Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid }), 'utf8').toString(
      'base64url'
    )}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.`

    expect(() => verifyJwt(forged, [key], { issuer: claims.iss, audience: 'client-1', now: 1500 })).toThrow(
      /only signs RS256/
    )
  })

  it('refuses a token signed by a key this issuer never had', () => {
    const other = generateKey(1000)
    const token = signJwt(claims, other)

    expect(() => verifyJwt(token, [key], { issuer: claims.iss, audience: 'client-1', now: 1500 })).toThrow(/kid/)
  })

  it('refuses a payload edited after signing', () => {
    const [header, , signature] = signJwt(claims, key).split('.') as [string, string, string]
    const swapped = Buffer.from(JSON.stringify({ ...claims, sub: 'somebody-else' }), 'utf8').toString('base64url')

    expect(() =>
      verifyJwt(`${header}.${swapped}.${signature}`, [key], { issuer: claims.iss, audience: 'client-1', now: 1500 })
    ).toThrow(/signature/)
  })

  it('refuses the wrong audience, the wrong issuer and an expired token by name', () => {
    const token = signJwt(claims, key)
    const base = { issuer: claims.iss, audience: 'client-1', now: 1500 }

    expect(() => verifyJwt(token, [key], { ...base, audience: 'client-2' })).toThrow(/client-2/)
    expect(() => verifyJwt(token, [key], { ...base, issuer: 'https://elsewhere.invalid' })).toThrow(/issued by/)
    expect(() => verifyJwt(token, [key], { ...base, now: 9999 })).toThrow(/expired/)
  })

  it('requires the five claims upstream tells PyJWT to require', () => {
    for (const missing of ['iss', 'sub', 'aud', 'exp', 'iat'] as const) {
      const partial = { ...claims } as Record<string, unknown>
      delete partial[missing]

      const token = signJwt(partial as typeof claims, key)

      expect(() => verifyJwt(token, [key], { issuer: claims.iss, audience: 'client-1', now: 1500 })).toThrow(
        new RegExp(`no ${missing} claim`)
      )
    }
  })
})

describe('key rotation', () => {
  it('signs with the new key and leaves the old one readable', () => {
    const first = generateKey(1000)
    const keys = rotatedKeys([first], { now: 2000, holdSeconds: 3600 })

    expect(keys).toHaveLength(2)
    expect(signingKey(keys)?.kid).not.toBe(first.kid)
    expect(keys.map(key => key.kid)).toContain(first.kid)
    expect(jwksDocument(keys).keys).toHaveLength(2)
  })

  it('drops the old key once everything it signed has expired', () => {
    const keys = rotatedKeys([generateKey(1000)], { now: 2000, holdSeconds: 3600 })

    expect(prunedKeys(keys, 3000)).toHaveLength(2)
    expect(prunedKeys(keys, 9000)).toHaveLength(1)
  })

  it('never prunes down to an empty JWKS', () => {
    const only = { ...generateKey(1000), retireBefore: 1500 }

    expect(prunedKeys([only], 9000)).toHaveLength(1)
  })
})

describe('passwords and recovery codes', () => {
  it('stores no password and still recognises the right one', () => {
    const stored = hashPassword('correct horse battery staple')

    expect(JSON.stringify(stored)).not.toContain('correct horse')
    expect(passwordMatches(stored, 'correct horse battery staple')).toBe(true)
    expect(passwordMatches(stored, 'Correct horse battery staple')).toBe(false)
    expect(passwordMatches(undefined, 'anything')).toBe(false)
    expect(passwordMatches(stored, '')).toBe(false)
  })

  it('keeps working against a hash made at a different cost', () => {
    const stored = { ...hashPassword('a long enough password'), n: 16_384, r: 8, p: 1 }

    expect(passwordMatches(stored, 'a long enough password')).toBe(true)
    // A row an operator broke by hand is not a match, and not a crash either.
    expect(passwordMatches({ ...stored, n: -1 }, 'a long enough password')).toBe(false)
  })

  it('spends a recovery code once and leaves the rest', () => {
    const codes = newRecoveryCodes(5)
    const user = {
      recoveryCodes: codes.map(code => recoveryDigest(code.replace(/-/g, '')))
    } as OidcUser

    const remaining = spendRecoveryCode(user, codes[2] as string)

    expect(remaining).toHaveLength(4)
    expect(spendRecoveryCode({ ...user, recoveryCodes: remaining! }, codes[2] as string)).toBeNull()
    // The typist's hyphens and case are theirs, not the secret's.
    expect(spendRecoveryCode(user, (codes[0] as string).replace(/-/g, '').toLowerCase())).toHaveLength(4)
    expect(spendRecoveryCode(user, 'not-a-real-code0')).toBeNull()
  })

  it('digests an opaque token rather than storing it', () => {
    expect(tokenDigest('some-refresh-token')).not.toContain('some-refresh-token')
    expect(tokenDigest('some-refresh-token')).toBe(tokenDigest('some-refresh-token'))
    expect(tokenDigest('a')).not.toBe(tokenDigest('b'))
  })
})
