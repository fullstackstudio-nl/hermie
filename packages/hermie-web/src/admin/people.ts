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
 * ## A third list, and where it comes in
 *
 * `HERMIE_ADMINS` (`env-admins.ts`) is a THIRD way an id ends up an
 * administrator, and this reconcile has to know about it or it undoes it: an
 * id the container names is an administrator regardless of what its role says
 * here, or even whether it has an account here at all, so `envAdmins` below is
 * checked before this file ever deletes anything from `admins`. And where the
 * id DOES have an account, the role is brought up to `admin` to match — the
 * same reasoning `/admin/people`'s own note gives for why the two switches
 * cannot be left to disagree, applied to a switch a container set rather than
 * a person — and brought back down to `user` once the container stops naming
 * it, unless a person has set the role since (`roleFromEnv`, below). None of
 * this touches `managedAdmins`: that ledger is
 * `env-admins.ts`'s own record of what an env reconcile added, and an id this
 * file adds because of a ROLE was never that, so it is never a candidate for
 * that reconcile to drop later regardless — see that file's note for why
 * tracking the positive fact is what makes that true.
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
 * `envAdmins` — `HERMIE_ADMINS`, read live — is what keeps this from undoing
 * `env-admins.ts`'s own reconcile: an id it names is an administrator
 * whatever its role here says, and whatever became of its account, so this
 * file never deletes one from `admins` over either. Call `promoteEnvAdminRoles`
 * first (below) so an id that DOES have an account here also shows `admin` on
 * this page, rather than relying only on the guard in this function to paper
 * over the disagreement.
 *
 * The same state object comes back when nothing had to change, so a caller can
 * write the file on `next !== state` and nothing else.
 */
export function reconcileIssuerPeople(
  state: AdminState,
  oidc: OidcState,
  envAdmins: readonly string[] = []
): AdminState {
  if (!oidc.enabled) {
    return state
  }

  const envSet = new Set(envAdmins)
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
    } else if (!envSet.has(account.sub)) {
      admins.delete(account.sub)
    }
    // else: the container still names this id — see the file note above.
    // `promoteEnvAdminRoles` should have already brought `role` up to
    // `admin` for it, and this branch is the backstop for whenever it has
    // not (a caller that skipped it, a test that reconciles directly).
  }

  // Gone accounts take their administrator entry with them, wherever the row
  // went — UNLESS the container still names the id, which needs no account
  // here to be an administrator at all.
  for (const id of state.admins) {
    if (!accounts.has(id) && state.users[id]?.fromIssuer === true && !envSet.has(id)) {
      admins.delete(id)
    }
  }

  const nextAdmins = [...admins].sort()
  const adminsMoved = nextAdmins.length !== state.admins.length || nextAdmins.some((id, at) => id !== state.admins[at])

  return changed || adminsMoved ? { ...state, admins: nextAdmins, users } : state
}

/**
 * Bring a `HERMIE_ADMINS` id's own issuer account role up to `admin`, before
 * `reconcileIssuerPeople` runs.
 *
 * Without this, an id the container names is kept on `admins` (that function's
 * own guard) while `/admin/oidc` still shows its role as `user` — the exact
 * disagreement between the two pages this file's whole design exists to rule
 * out, just caused by a container instead of a person forgetting to tick a
 * box. Touches only an account that already exists and is not already
 * `admin`; it invents no accounts and demotes nobody.
 *
 * Every role it raises is marked `roleFromEnv`, in the same account record
 * and therefore the same write: that mark is the only thing that lets
 * `demoteFormerEnvAdminRoles` below give the role back once the container
 * stops naming the id. A role that was already `admin` is left unmarked —
 * the container did not raise it, so it has nothing to give back.
 *
 * The same state object comes back when nothing had to change.
 */
export function promoteEnvAdminRoles(oidc: OidcState, envAdmins: readonly string[]): OidcState {
  if (!oidc.enabled || !envAdmins.length) {
    return oidc
  }

  const envSet = new Set(envAdmins)
  let changed = false

  const users = oidc.users.map(user => {
    if (user.role !== 'admin' && envSet.has(user.sub)) {
      changed = true

      return { ...user, role: 'admin' as const, roleFromEnv: true as const }
    }

    return user
  })

  return changed ? { ...oidc, users } : oidc
}

/**
 * The other half of `promoteEnvAdminRoles`: an account whose `admin` role the
 * container raised (`roleFromEnv`) and that `HERMIE_ADMINS` no longer names
 * goes back to `user`, and `reconcileIssuerPeople` then takes it off `admins`
 * the ordinary way.
 *
 * Without this the raised role outlived the option: `reconcileEnvAdmins`
 * dropped the id from `admins`, and the very same pass put it back as an
 * ordinary, unmanaged administrator because its role still read `admin`. A
 * role a person set is never marked (`setAccountRole` clears the mark), so
 * this never touches one.
 *
 * Only while the provider is enabled, like its counterpart: a disabled
 * provider's roles decide nothing about `admins`, so the caller's "never the
 * last way into /admin" check could not see what a demotion there would cost
 * the day the provider is enabled again. The mark simply waits until then.
 * Whether the demotion may happen at all is the caller's call, since only the
 * caller sees the whole administrator list; see `admin/reconcile.ts`.
 */
export function demoteFormerEnvAdminRoles(
  oidc: OidcState,
  envAdmins: readonly string[]
): { oidc: OidcState; demoted: string[] } {
  if (!oidc.enabled) {
    return { oidc, demoted: [] }
  }

  const envSet = new Set(envAdmins)
  const demoted: string[] = []

  const users = oidc.users.map(user => {
    if (user.roleFromEnv && !envSet.has(user.sub)) {
      demoted.push(user.sub)

      const { roleFromEnv: _cleared, ...rest } = user

      return { ...rest, role: 'user' as const }
    }

    return user
  })

  return demoted.length ? { oidc: { ...oidc, users }, demoted } : { oidc, demoted }
}
