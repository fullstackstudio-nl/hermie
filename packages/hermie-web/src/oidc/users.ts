/**
 * The people this issuer knows, and the one place a password is turned into
 * something that can be stored.
 *
 * This is the file that makes ADR-0015's "Hermie Web has no user database"
 * false, and it should be read as the deliberate exception it is: it exists
 * only when the built-in provider is ENABLED, which is off by default and which
 * ADR-0025's amendment argues for at length. A deployment that points the
 * gateway at Authentik or Keycloak never creates one of these records.
 *
 * ## scrypt, and the honest note about argon2
 *
 * `scrypt` is what `node:crypto` offers, and ADR-0015 forbids a runtime
 * dependency in this package. **Argon2id is the better password hash** — it is
 * what OWASP recommends first and what a purpose-built identity provider would
 * use — and it is a native module. So the trade is stated rather than hidden:
 * this provider hashes with scrypt at N=2^14, r=8, p=1, a 16-byte per-password
 * salt and a 64-byte tag, which is Node's own default cost and roughly 16 MB
 * and ~50 ms of work per guess. That is a real wall against an offline attack
 * on a stolen state file and it is weaker than argon2id at the same latency.
 *
 * The parameters are stored WITH each hash rather than assumed, so raising the
 * cost later re-hashes on next sign-in instead of locking everybody out.
 *
 * ## What is never stored
 *
 * The password, the TOTP code, and the recovery codes as text. The TOTP SECRET
 * is stored — it has to be, because verifying a TOTP means recomputing it — and
 * that is the sharpest thing in the state directory after the signing key. The
 * threat model in ADR-0025 says so in those words.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { normalizeRecoveryCode } from './totp'

/** Roles this provider understands. They ride in the ID token as `groups`. */
export const OIDC_ROLES = ['user', 'admin'] as const

export type OidcRole = (typeof OIDC_ROLES)[number]

/** One password hash, with the cost it was made at. */
export interface PasswordHash {
  salt: string
  hash: string
  /** scrypt's cost parameter, stored so it can be raised without a migration. */
  n: number
  r: number
  p: number
}

export const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, keylen: 64 } as const

/**
 * `maxmem` has to be raised above Node's 32 MB default for anything but the
 * smallest N: the requirement is roughly `128 * N * r` bytes, which at
 * N=16384, r=8 is 16 MB — under the default, but only just. Naming a ceiling
 * here means a later increase to N is a one-line change rather than a puzzling
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` at sign-in.
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): PasswordHash {
  const { n, r, p, keylen } = SCRYPT_PARAMS

  return {
    salt,
    hash: scryptSync(password, salt, keylen, { N: n, r, p, maxmem: SCRYPT_MAXMEM }).toString('hex'),
    n,
    r,
    p
  }
}

/**
 * Constant-time check against a stored hash.
 *
 * The stored parameters are used rather than the current ones, which is what
 * lets an old hash keep working after the cost is raised.
 */
export function passwordMatches(stored: PasswordHash | undefined, password: string): boolean {
  if (!stored || !password) {
    return false
  }

  const held = Buffer.from(stored.hash, 'hex')
  let offered: Buffer

  try {
    offered = scryptSync(password, stored.salt, held.length, {
      N: stored.n,
      r: stored.r,
      p: stored.p,
      maxmem: SCRYPT_MAXMEM
    })
  } catch {
    // A record with parameters this build cannot compute is not a match. It is
    // also not a crash: one hand-edited row must not close the sign-in page.
    return false
  }

  return offered.length === held.length && timingSafeEqual(offered, held)
}

/** One account. `sub` is the claim, and therefore the id the gateway will report. */
export interface OidcUser {
  /**
   * The `sub` claim, generated once and never reused.
   *
   * It is opaque rather than the username on purpose. Upstream maps the ID
   * token's `sub` straight onto `Session.user_id`, which is what
   * `/api/auth/me` answers and therefore what this service's own administrator
   * list is keyed by (`admin/access.ts`). A `sub` that changed when somebody
   * was renamed would silently remove their access here; a `sub` that was
   * reused when a username was recreated would silently GRANT it.
   */
  sub: string
  username: string
  email: string
  displayName: string
  role: OidcRole
  /**
   * `true` while `role` is `admin` ONLY because a `HERMIE_ADMINS` reconcile
   * raised it (`admin/people.ts`'s `promoteEnvAdminRoles`). It is what lets
   * the reconcile lower the role back to `user` once the container stops
   * naming the id, instead of the raised role outliving the option as an
   * ordinary administrator. Stored on the account, in the same write as the
   * role it explains, so the two can never be persisted apart. Cleared by any
   * role a PERSON sets (`setAccountRole`); absent on every other account.
   */
  roleFromEnv?: true
  password?: PasswordHash
  /** Base32 TOTP secret once enrolment is confirmed; empty when there is none. */
  totpSecret: string
  /** Digests of the unused recovery codes. Never the codes. */
  recoveryCodes: string[]
  disabled: boolean
  createdAt: number
  /** Unix seconds of the last successful sign-in, or `0`. */
  lastSignInAt: number
  /**
   * A one-time invitation, when the account has no password yet.
   *
   * The digest of a link token and when it lapses. This is how an operator
   * creates somebody without ever choosing, transmitting or knowing their
   * password — which is the only way to create an account that does not end
   * with a password in a chat window.
   */
  invite?: { digest: string; expiresAt: number }
}

/** A username, as it is compared: trimmed and case-folded. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

export function findUser(users: readonly OidcUser[], username: string): OidcUser | null {
  const wanted = normalizeUsername(username)

  return users.find(user => normalizeUsername(user.username) === wanted) ?? null
}

export function findUserBySub(users: readonly OidcUser[], sub: string): OidcUser | null {
  return users.find(user => user.sub === sub) ?? null
}

/** A fresh `sub`: 128 bits, base64url, which is neither guessable nor meaningful. */
export function newSub(random: (size: number) => Buffer = randomBytes): string {
  return random(16).toString('base64url')
}

/**
 * Spend a recovery code, answering the remaining digests.
 *
 * `null` means it was not one of them. A code that matched is removed, which is
 * what makes it single-use — and the removal is the caller's to persist, so
 * that a code cannot be spent by a read that is never written.
 */
export function spendRecoveryCode(user: OidcUser, offered: string): string[] | null {
  const normalized = normalizeRecoveryCode(offered)

  if (!normalized) {
    return null
  }

  // The digest is the same one `hashPassword` would make with a fixed salt: a
  // recovery code is 80 bits of randomness, so it needs no cost factor to
  // resist guessing, and a per-code salt would mean N scrypt runs per attempt.
  const digest = recoveryDigest(normalized)
  let found = false
  const remaining: string[] = []

  for (const held of user.recoveryCodes) {
    // Every entry is compared, and the loop never breaks early: how long this
    // takes must not say which code matched or how far down the list it was.
    if (held.length === digest.length && timingSafeEqual(Buffer.from(held), Buffer.from(digest))) {
      found = true

      continue
    }

    remaining.push(held)
  }

  return found ? remaining : null
}

/** The stored form of a recovery code. */
export function recoveryDigest(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('base64url')
}
