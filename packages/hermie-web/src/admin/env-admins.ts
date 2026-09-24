/**
 * `HERMIE_ADMINS` (or `--admins`): administrators a container declares,
 * enforced on every start.
 *
 * The rule is short and the reason it needs a file of its own is that it has
 * to be right in both directions at once:
 *
 *  - **Enforced.** Every id the option names is an administrator by the time
 *    this reconcile is done, whether or not it already was one.
 *  - **Reversible, but only for what THIS RECONCILE added.** An id that fell
 *    off the list since the last start loses its administrator status —
 *    unless it reached `admins` any other way, in which case dropping it from
 *    the option must change nothing at all. Two starts with the same list
 *    must therefore behave identically to one, which is what makes this
 *    idempotent rather than a one-way ratchet.
 *
 * `AdminState.managedAdmins` is the ledger that makes the second rule
 * possible, and it is deliberately a POSITIVE record — an id joins it only
 * when THIS function adds it because the option named it — never a guess
 * worked out from "nothing else claims to have put it there". An earlier
 * version tried the guess: it kept a `manualAdmins` list of ids added BY HAND
 * and treated its complement within `admins` as "therefore env-managed,
 * therefore droppable". That reads right until an id reaches `admins` a
 * THIRD way that never recorded itself as manual — a hand-edited file, an
 * account whose role was set `admin` on `/admin/oidc` before that path wrote
 * anything down, a state directory from before either list existed. None of
 * those looked "manual" to the guess, so the very next reconcile — triggered
 * by an UNRELATED id appearing in `HERMIE_ADMINS` — read the silence as
 * license and dropped an administrator nobody had asked it to touch. Tracking
 * the positive fact instead means an id this function never added is an id
 * it will never remove, whatever else put it on `admins` and whatever else is
 * true about anybody else on the list.
 *
 * `admin/access.ts`'s `withoutAdmin` is the other half of "protected": it
 * refuses to remove an id that is CURRENTLY on the option through `/admin` or
 * its forms, checked live against the option rather than against anything
 * stored, so a container restarted with a shorter list is the only way to
 * actually let one go.
 */
import type { AdminState } from './state'

/**
 * Bring `admins` into step with what this start's `HERMIE_ADMINS` says,
 * touching nothing this function itself did not put there.
 *
 * Answers the SAME OBJECT when there is nothing to do, the same convention
 * `people.ts`'s `reconcileIssuerPeople` uses, so a caller can write the file on
 * `next !== state` alone.
 */
export function reconcileEnvAdmins(
  state: AdminState,
  envAdmins: readonly string[],
  onKept: (ids: readonly string[]) => void = () => undefined
): AdminState {
  const wanted = new Set(envAdmins)
  const missing = envAdmins.filter(id => !state.admins.includes(id))

  // Enforced: everybody the option names lands on both lists — `admins`,
  // because that is the whole point, and `managedAdmins`, because THIS
  // function is the reason they are here and the only reconcile allowed to
  // act on that fact later.
  const admins = missing.length ? [...state.admins, ...missing].sort() : state.admins
  const managedAdmins = missing.length ? [...state.managedAdmins, ...missing].sort() : state.managedAdmins

  // Droppable: an id THIS reconcile put on `admins` at some past start, and
  // this start's option no longer names. Nothing else is a candidate —
  // not an id a person added by hand, not one an issuer role granted, not one
  // a hand-edited file simply had — because none of those are in
  // `managedAdmins` to begin with.
  const droppable = managedAdmins.filter(id => !wanted.has(id))

  if (!droppable.length) {
    return admins === state.admins && managedAdmins === state.managedAdmins
      ? state
      : { ...state, admins, managedAdmins }
  }

  const afterDrops = admins.filter(id => !droppable.includes(id))

  /*
    Never leave nobody able to reach /admin over an environment change alone —
    the same rule `withoutAdmin` enforces when a person tries to remove the
    last administrator by hand. The env-only administrators stay, still
    droppable next time, until a person adds another way in. `onKept` hears
    about it, so the service can say in its log why an id the container no
    longer names can still open /admin.
  */
  if (!afterDrops.length && !state.localAdmin) {
    onKept(droppable)

    return admins === state.admins && managedAdmins === state.managedAdmins
      ? state
      : { ...state, admins, managedAdmins }
  }

  return { ...state, admins: afterDrops, managedAdmins: managedAdmins.filter(id => !droppable.includes(id)) }
}
