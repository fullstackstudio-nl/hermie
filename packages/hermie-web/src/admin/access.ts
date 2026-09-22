/**
 * Who may open `/admin`, and what the per-user options actually do.
 *
 * ## The gate
 *
 * Two ways in, and they exist for two different kinds of deployment:
 *
 *  - **A gateway with accounts.** The gate is a gateway user id in
 *    `AdminState.admins`. The gateway authenticates — this service never sees a
 *    password, never issues a session and never decides whether a cookie is
 *    real; it asks `/api/auth/me` with `{ fresh: true }` and believes the
 *    answer. The first administrator is whoever completed `/setup`, because
 *    that is the one moment this process can point at somebody and say "that
 *    person is the operator" without being told.
 *  - **A gateway with no accounts.** There is nobody to name, so `/setup` can
 *    offer a local administrator secret instead. It is `scrypt` with a
 *    per-credential salt and it unlocks this page and nothing else: it is not a
 *    gateway session, it cannot read a chat, and it is stored as a hash so the
 *    page has nothing to echo back.
 *
 * ## The per-user options, and the part that is a deterrent rather than a wall
 *
 * `allowedBots`, `readOnly` and `pushAllowed` are **service-level**. They say
 * what THIS proxy and THIS push daemon will do. They are not gateway
 * permissions, because the gateway has none to set — and the place that matters
 * is worth saying out loud rather than burying:
 *
 * > **The WebSocket is a raw byte pipe** (ADR-0015). Everything the app does of
 * > consequence — sending a prompt, answering an approval, configuring a
 * > profile — travels over it, and this service cannot read a frame of it
 * > without terminating the protocol and re-implementing the gateway's own
 * > contract. So `readOnly` refuses every mutating request that arrives over
 * > HTTP, which is uploads and the REST surface, and it does not and cannot
 * > stop somebody typing into a chat.
 *
 * What IS enforced, completely:
 *
 *  - **Push.** The daemon is ours, so `pushAllowed` and `allowedBots` decide
 *    what it sends and to whom, before anything leaves the process.
 *  - **The message cache.** `/hermie/cache/<key>` is ours, so a bot somebody
 *    may not reach is not served from it.
 *  - **Mutating HTTP.** `POST`, `PUT`, `PATCH` and `DELETE` to `/api/*` are
 *    refused for a read-only reader, which is where file uploads go.
 *
 * The admin page says the same thing beside the switches, because an operator
 * who believes `readOnly` is a security boundary has been misled by us.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import type { GatewayIdentity } from '../identity'
import type { AdminState } from './state'

/** `scrypt` parameters. Node's defaults, named so a reader can see there are some. */
const SCRYPT_KEYLEN = 64

/** Hash a local administrator secret. The secret itself is never stored. */
export function hashLocalSecret(
  secret: string,
  salt = randomBytes(16).toString('hex')
): { salt: string; hash: string } {
  return { salt, hash: scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex') }
}

/** Constant-time check of a local administrator secret. */
export function localSecretMatches(state: AdminState, secret: string): boolean {
  const stored = state.localAdmin

  if (!stored || !secret) {
    return false
  }

  const offered = scryptSync(secret, stored.salt, SCRYPT_KEYLEN)
  const held = Buffer.from(stored.hash, 'hex')

  // A length mismatch is its own answer and `timingSafeEqual` throws on one.
  return offered.length === held.length && timingSafeEqual(offered, held)
}

/**
 * Is this identity an administrator of this service?
 *
 * A gateway that named nobody answers false however many ids are on the list:
 * `''` is not a user id, and an empty name matching an empty entry is exactly
 * the bug that would open this page to anyone who can reach the port.
 */
export function isAdminIdentity(state: AdminState, identity: GatewayIdentity | null): boolean {
  const userId = identity?.userId ?? ''

  return Boolean(userId) && state.admins.includes(userId)
}

/**
 * Add an administrator, keeping the list a set and in a stable order.
 *
 * Sorted so the file does not churn and two operators editing it do not
 * produce a diff that is only an order.
 */
export function withAdmin(state: AdminState, userId: string): AdminState {
  if (!userId || state.admins.includes(userId)) {
    return state
  }

  return { ...state, admins: [...state.admins, userId].sort() }
}

/**
 * Remove one, refusing to remove the last.
 *
 * A service with no administrators and no local secret is one nobody can
 * configure again without editing JSON on the host, which is a state an
 * operator should have to choose deliberately rather than reach by tidying a
 * list. The local secret counts as an administrator for this rule.
 */
export function withoutAdmin(state: AdminState, userId: string): { state: AdminState; removed: boolean } {
  if (!state.admins.includes(userId)) {
    return { state, removed: false }
  }

  const rest = state.admins.filter(id => id !== userId)

  if (!rest.length && !state.localAdmin) {
    return { state, removed: false }
  }

  return { state: { ...state, admins: rest }, removed: true }
}

/** The HTTP methods a read-only reader may still send to the gateway. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function mayProxyMethod(readOnly: boolean, method: string): boolean {
  return !readOnly || READ_METHODS.has(method.toUpperCase())
}
