import { describe, expect, it } from 'vitest'

import { reconcileEnvAdmins } from './env-admins'
import { emptyAdminState } from './state'

const state = (over: Partial<ReturnType<typeof emptyAdminState>> = {}) => ({ ...emptyAdminState(), ...over })

const ADA = 'ada@example.invalid'
const GRACE = 'grace@example.invalid'

describe('reconcileEnvAdmins', () => {
  it('adds every id the container names that is not already an administrator', () => {
    const next = reconcileEnvAdmins(state(), [ADA, GRACE])

    expect(next.admins).toEqual([ADA, GRACE])
    // Recorded as env-managed: this reconcile is what put them there.
    expect(next.managedAdmins).toEqual([ADA, GRACE])
  })

  it('answers the same object when nothing changed', () => {
    const held = state({ admins: [ADA], managedAdmins: [ADA] })

    expect(reconcileEnvAdmins(held, [ADA])).toBe(held)
  })

  it('leaves an already-administrator id alone, and never marks it env-managed', () => {
    // Already an admin some OTHER way (by hand, an issuer role, a hand-edited
    // file) before the option ever named it — so it is not "missing" and this
    // reconcile never touches `managedAdmins` for it.
    const held = state({ admins: [ADA], managedAdmins: [] })
    const next = reconcileEnvAdmins(held, [ADA])

    expect(next).toBe(held)
    expect(next.managedAdmins).toEqual([])
  })

  it('drops an administrator that was only there because a past start named it', () => {
    // Two, so dropping one still leaves a way in — the safety net below is
    // its own test.
    const afterFirstStart = reconcileEnvAdmins(state(), [ADA, GRACE])

    expect(afterFirstStart.admins).toEqual([ADA, GRACE])

    const afterSecondStart = reconcileEnvAdmins(afterFirstStart, [GRACE])

    expect(afterSecondStart.admins).toEqual([GRACE])
    expect(afterSecondStart.managedAdmins).toEqual([GRACE])
  })

  it('keeps an administrator the list stops naming, when it was never the one that added it', () => {
    // This is the bug the positive ledger exists to rule out: an id that
    // reached `admins` some OTHER way (seeded directly here, an issuer role,
    // a hand-edited file) must never be read as "env-managed, and no longer
    // wanted" just because it is not in `managedAdmins` — the absence of a
    // record is not evidence of anything.
    const held = state({ admins: [ADA], managedAdmins: [] })
    const next = reconcileEnvAdmins(held, [])

    expect(next).toBe(held)
  })

  it('drops one env-managed id and keeps an unrelated administrator alone, in the same reconcile', () => {
    // ADA is an administrator this reconcile never added (never in
    // `managedAdmins`); GRACE was added by a past start's list and this
    // start's no longer names her.
    const held = state({ admins: [ADA, GRACE], managedAdmins: [GRACE] })
    const next = reconcileEnvAdmins(held, [])

    expect(next.admins).toEqual([ADA])
    expect(next.managedAdmins).toEqual([])
  })

  it('never leaves nobody able to reach /admin over an environment change alone, with no local secret', () => {
    const held = state({ admins: [ADA], managedAdmins: [ADA] })
    const next = reconcileEnvAdmins(held, [])

    // The only administrator was env-managed and the list is now empty —
    // dropping it would lock the deployment out, so it stays.
    expect(next).toBe(held)
  })

  it('does drop the last one when a local secret is still a way in', () => {
    const held = state({
      admins: [ADA],
      managedAdmins: [ADA],
      localAdmin: { salt: 'a'.repeat(32), hash: 'b'.repeat(128) }
    })
    const next = reconcileEnvAdmins(held, [])

    expect(next.admins).toEqual([])
    expect(next.managedAdmins).toEqual([])
  })

  it('is idempotent: reconciling twice with the same list is the same as once', () => {
    const once = reconcileEnvAdmins(state(), [ADA, GRACE])
    const twice = reconcileEnvAdmins(once, [ADA, GRACE])

    expect(twice).toBe(once)
  })

  it('a second, unrelated admin already on the file is never at risk from an env reconcile', () => {
    // The regression this whole design is about: seed a state exactly the way
    // a fixture (or a hand-edited file) can — an administrator with no
    // `managedAdmins` entry — then have the option name a DIFFERENT id. The
    // first administrator must survive, however many times this runs.
    const held = state({ admins: [ADA], managedAdmins: [] })
    const withGrace = reconcileEnvAdmins(held, [GRACE])

    expect(withGrace.admins.sort()).toEqual([ADA, GRACE].sort())

    const next = reconcileEnvAdmins(withGrace, [GRACE])

    expect(next.admins).toContain(ADA)
  })
})
