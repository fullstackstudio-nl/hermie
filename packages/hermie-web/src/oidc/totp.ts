/**
 * RFC 6238 time-based one-time passwords, and the recovery codes that exist
 * because phones are lost.
 *
 * HMAC-SHA1 is not a mistake and not a legacy we inherited. RFC 6238 allows
 * SHA-256 and SHA-512, but every authenticator an operator already has —
 * Google Authenticator, 1Password, Aegis, Bitwarden — implements the SHA-1
 * profile and several silently assume it when an `otpauth://` URI says
 * otherwise. A second factor nobody can enrol is not a second factor. The
 * construction's security does not rest on SHA-1's collision resistance: HMAC
 * with a 160-bit random key is unaffected by the collision attacks that retired
 * SHA-1 for signatures.
 *
 * Everything here is `node:crypto` (ADR-0015), including the base32 that
 * `otpauth://` URIs are written in, which Node has no encoder for.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 6238's default step. Every authenticator assumes it; none of them ask. */
export const TOTP_STEP_SECONDS = 30

/** Six digits, for the same reason. */
export const TOTP_DIGITS = 6

/**
 * How many steps either side of now are accepted.
 *
 * One step — thirty seconds back and forward — covers a phone whose clock has
 * drifted and the very common case of a code typed as it rolls over. Wider
 * would multiply the number of codes valid at any moment for no real gain in
 * usability.
 */
export const TOTP_WINDOW_STEPS = 1

/** 160 bits, which is the HMAC-SHA1 block key size and what every app expects. */
const SECRET_BYTES = 20

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, unpadded — the form `otpauth://` URIs carry. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }

  return out
}

/** The inverse. Spaces and lower case are accepted because people retype these. */
export function base32Decode(text: string): Buffer {
  const cleaned = text.replace(/[\s=]/g, '').toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)

    if (index < 0) {
      throw new Error('that is not a base32 secret')
    }

    value = (value << 5) | index
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

/** A fresh TOTP secret, base32, ready to be shown once and never again. */
export function newTotpSecret(random: (size: number) => Buffer = randomBytes): string {
  return base32Encode(random(SECRET_BYTES))
}

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  // A 64-bit counter written as two 32-bit halves, because `writeBigUInt64BE`
  // would mean carrying a BigInt through a function that never needs one.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', secret).update(message).digest()
  // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte picks
  // where the four-byte window starts.
  const offset = (digest[digest.length - 1] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The code an authenticator would be showing at `now`. */
export function totpAt(secretBase32: string, now: number = Math.floor(Date.now() / 1000)): string {
  return hotp(base32Decode(secretBase32), Math.floor(now / TOTP_STEP_SECONDS))
}

/**
 * Is this the code for now, or for the step either side of it?
 *
 * Every candidate is compared in constant time and the loop is not cut short on
 * a match, so the time this takes says nothing about which step matched — or
 * whether any did.
 */
export function totpMatches(
  secretBase32: string,
  code: string,
  options: { now?: number; window?: number } = {}
): boolean {
  const offered = code.replace(/\s/g, '')

  if (!/^\d{6}$/.test(offered)) {
    return false
  }

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const window = options.window ?? TOTP_WINDOW_STEPS
  const secret = base32Decode(secretBase32)
  const step = Math.floor(now / TOTP_STEP_SECONDS)
  const wanted = Buffer.from(offered, 'ascii')
  let matched = false

  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = Buffer.from(hotp(secret, step + drift), 'ascii')

    // Not `||=` and not an early return: every step is compared on every call.
    if (timingSafeEqual(candidate, wanted)) {
      matched = true
    }
  }

  return matched
}

/**
 * The URI an authenticator app scans.
 *
 * The label carries the issuer twice — once as the `Issuer:Account` prefix and
 * once as a parameter — which looks redundant and is not: older apps read the
 * prefix, newer ones read the parameter, and an app that reads neither shows
 * the account with no idea what it belongs to.
 */
export function otpauthUri(options: { issuerName: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${options.issuerName}:${options.account}`)
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuerName,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  })

  return `otpauth://totp/${label}?${params.toString()}`
}

/** How many recovery codes an enrolment gets. */
export const RECOVERY_CODE_COUNT = 10

/**
 * Recovery codes: readable, unambiguous, and each usable once.
 *
 * Base32 without `0`/`1`/`8`/`O`/`I`/`B` would be tidier still, but the
 * alphabet is already the one people copy out of authenticator apps, and
 * hyphenating in fours is what stops somebody losing their place. They are
 * stored as digests, never as text — see `users.ts`.
 */
export function newRecoveryCodes(
  count = RECOVERY_CODE_COUNT,
  random: (size: number) => Buffer = randomBytes
): string[] {
  return Array.from({ length: count }, () => {
    const body = base32Encode(random(10)).slice(0, 16)

    return `${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`
  })
}

/** How a recovery code is compared: case and hyphens are the typist's, not the secret's. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}
