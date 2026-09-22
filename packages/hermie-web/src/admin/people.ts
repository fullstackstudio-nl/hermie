/**
 * The one list of people, from two places that both name them.
 *
 * ## Why there were two lists, and why there is one now
 *
 * `/admin` keys everybody by GATEWAY USER ID, because that is what the gate is:
 * this service asks `/api/auth/me` and believes the answer (`access.ts`).
 * `/admin/oidc` keys its accounts by `sub`, because that is what an OpenID
 * Provider issues. Those look like two different things and are not:
 *
 * > Upstream maps the ID token's `sub` straight onto `Session.user_id`, which is
 * > what `/api/auth/me` answers.
 *
 * So **when the built-in provider is enabled, its `sub` IS the gateway user
 * id**, and an account created on one page is a person the other page should
 * already know about. Before this, creating an administrator on `/admin/oidc`
 * left `/admin` showing nobody, and made an operator add the same person twice
 * by copying an opaque 22-character string between two pages.
 *
 * ## The rules, which are the whole of it
 *
 * Only while the provider is **enabled**, because only then does its `sub`
 * answer for anything:
 *
 *  - every account has a row on the people list, from the moment it is created
 *    and before it has ever signed in;
 *  - an account whose role is `admin` is on this service's administrator list,
 *    and one whose role is not is not;
 *  - an account that is deleted takes its administrator entry with it, and takes
 *    its row too **unless this service has actually seen that person sign in** —
 *    a row with a last-seen time is a record of something that happened, and
 *    deleting an account does not unhappen it.
 *
 * Ids that belong to no account are never touched. A deployment whose gateway
 * has its own accounts keeps every one of them on the list beside these.
 *
 * **A disabled provider changes nothing.** Not because it would be wrong in
 * principle — its accounts are not gateway users while it is off — but because
 * the one thing that must never happen here is an operator turning the provider
 * off to test something and finding they are no longer an administrator of the
 * service they turned it off from.
 *
 * ## Idempotent, and therefore also the migration
 *
 * It answers the SAME OBJECT when there is nothing to do, which is what lets it
 * run on every write and at every start without churning the file. A deployment
 * that predates this reconciles once, on its next start, and then never again.
 */
import type { OidcState } from '../oidc/state'
import { DEFAULT_USER_OPTIONS, type AdminState, type AdminUserRow } from './state'

/**
 * Is this row here because the issuer vouches for it?
 *
 * Stored rather than derived, because the question that matters is asked at the
 * moment the account is already GONE: a row with no last-seen time and no
 * account might be one this reconcile created, or one an operator typed in by
 * hand on the people page, and removing the second would be this service
 * deleting a decision somebody made.
 */
export const fromIssuer = (row: AdminUserRow): boolean => row.fromIssuer === true

function rowFor(
  held: AdminUserRow | undefined,
  account: { sub: string; username: string; email: string; displayName: string }
): AdminUserRow {
  return {
    ...(held ?? { ...DEFAULT_USER_OPTIONS, userId: account.sub, seenAt: 0, displayName: '', email: '' }),
    userId: account.sub,
    // The provider is the authority on a name it issued. `noteSeen` writes the
    // same two values out of `/api/auth/me`, which got them from a token this
    // provider signed, so there is nothing here for the two to disagree about.
    displayName: account.displayName || account.username,
    email: account.email,
    fromIssuer: true
  }
}

const sameRow = (left: AdminUserRow, right: AdminUserRow): boolean =>
  left.displayName === right.displayName &&
  left.email === right.email &&
  left.fromIssuer === right.fromIssuer &&
  left.seenAt === right.seenAt &&
  left.readOnly === right.readOnly &&
  left.pushAllowed === right.pushAllowed &&
  String(left.allowedBots) === String(right.allowedBots)

/**
 * Bring the people list and the administrator list into step with the issuer.
 *
 * The same state object comes back when nothing had to change, so a caller can
 * write the file on `next !== state` and nothing else.
 */
export function reconcileIssuerPeople(state: AdminState, oidc: OidcState): AdminState {
  if (!oidc.enabled) {
    return state
  }

  const accounts = new Map(oidc.users.map(user => [user.sub, user]))
  const users: Record<string, AdminUserRow> = {}
  let changed = false

  for (const [userId, held] of Object.entries(state.users)) {
    const account = accounts.get(userId)

    if (account) {
      const next = rowFor(held, account)

      users[userId] = sameRow(held, next) ? held : next
      changed ||= users[userId] !== held

      continue
    }

    if (fromIssuer(held) && !held.seenAt) {
      // Created by this reconcile, never seen: it exists only because the
      // account did, and the account does not.
      changed = true

      continue
    }

    if (fromIssuer(held)) {
      // Seen at least once, so the row stays — but it is nobody's account now.
      users[userId] = { ...held, fromIssuer: false }
      changed = true

      continue
    }

    users[userId] = held
  }

  for (const account of oidc.users) {
    if (!users[account.sub]) {
      users[account.sub] = rowFor(undefined, account)
      changed = true
    }
  }

  const admins = new Set(state.admins)

  for (const account of oidc.users) {
    if (account.role === 'admin') {
      admins.add(account.sub)
    } else {
      admins.delete(account.sub)
    }
  }

  // Gone accounts take their administrator entry with them, wherever the row
  // went: an id nothing can authenticate as is an entry nobody can ever use.
  for (const id of state.admins) {
    if (!accounts.has(id) && state.users[id]?.fromIssuer === true) {
      admins.delete(id)
    }
  }

  const nextAdmins = [...admins].sort()
  const adminsMoved = nextAdmins.length !== state.admins.length || nextAdmins.some((id, at) => id !== state.admins[at])

  return changed || adminsMoved ? { ...state, admins: nextAdmins, users } : state
}
