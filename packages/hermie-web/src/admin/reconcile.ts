/**
 * `HERMIE_ADMINS`, the built-in issuer's roles and `admins`, brought into step
 * in ONE pure pass — what `server.ts`'s `reconcileAdminState` computes before
 * it writes anything.
 *
 * The order is the whole design:
 *
 *  1. `promoteEnvAdminRoles`: an issuer account the container names gets role
 *     `admin`, marked `roleFromEnv`.
 *  2. `demoteFormerEnvAdminRoles`: an account whose role the container raised
 *     and no longer names goes back to `user`.
 *  3. `reconcileEnvAdmins`, then `reconcileIssuerPeople`: `admins` follows the
 *     option and the roles.
 *
 * Step 2 is held back when it would leave nobody able to open `/admin` — no
 * administrator left and no local secret — the same rule `reconcileEnvAdmins`
 * and `withoutAdmin` apply. The raised roles then stay, still marked, so the
 * next start tries again; nothing is lost by waiting for a person to add
 * another way in. Every id kept that way is reported in `kept`, with why.
 */
import type { OidcState } from '../oidc/state'
import { reconcileEnvAdmins } from './env-admins'
import { demoteFormerEnvAdminRoles, promoteEnvAdminRoles, reconcileIssuerPeople } from './people'
import type { AdminState } from './state'

export interface KeptAdmin {
  id: string
  reason: string
}

export interface AdminReconcile {
  admin: AdminState
  oidc: OidcState
  kept: KeptAdmin[]
}

const LAST_WAY_IN =
  'no longer named by HERMIE_ADMINS, but kept: it is the last way into /admin (no other administrator and no local secret)'

/**
 * Answers the SAME `admin` and `oidc` objects when nothing had to change, so a
 * caller can write each file on `next !== current` alone.
 */
export function reconcileAdminAndIssuer(
  admin: AdminState,
  oidc: OidcState,
  envAdmins: readonly string[]
): AdminReconcile {
  const kept: KeptAdmin[] = []
  const envReconciled = reconcileEnvAdmins(admin, envAdmins, ids => {
    kept.push(...ids.map(id => ({ id, reason: `administrator ${LAST_WAY_IN}` })))
  })
  const promoted = promoteEnvAdminRoles(oidc, envAdmins)
  const { oidc: demoted, demoted: demotedIds } = demoteFormerEnvAdminRoles(promoted, envAdmins)
  const next = reconcileIssuerPeople(envReconciled, demoted, envAdmins)

  if (demotedIds.length && !next.admins.length && !next.localAdmin) {
    for (const id of demotedIds) {
      if (!kept.some(entry => entry.id === id)) {
        kept.push({ id, reason: `issuer role ${LAST_WAY_IN}` })
      }
    }

    return settled(reconcileIssuerPeople(envReconciled, promoted, envAdmins), promoted, kept)
  }

  return settled(next, demoted, kept)
}

/**
 * The last word on what this pass kept. `reconcileEnvAdmins` decides "the last
 * way in" before the issuer's roles have had their say, so an id it kept can
 * still leave `admins` in the same pass (its raised role was given back and
 * somebody else is an administrator now): such an id was not kept after all,
 * and is neither reported nor left on `managedAdmins`.
 */
function settled(admin: AdminState, oidc: OidcState, kept: KeptAdmin[]): AdminReconcile {
  const stillManaged = admin.managedAdmins.filter(id => admin.admins.includes(id))

  return {
    admin: stillManaged.length === admin.managedAdmins.length ? admin : { ...admin, managedAdmins: stillManaged },
    oidc,
    kept: kept.filter(entry => admin.admins.includes(entry.id))
  }
}
