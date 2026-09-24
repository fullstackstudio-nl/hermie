import { describe, expect, it } from 'vitest'

import { ADMIN_STATE_VERSION, adminStateOf, emptyAdminState } from './state'

describe('adminStateOf', () => {
  it('answers empty defaults for nothing at all', () => {
    expect(adminStateOf(undefined)).toEqual(emptyAdminState())
    expect(adminStateOf(null)).toEqual(emptyAdminState())
  })

  it('reads a file written before managedAdmins existed as nobody being env-managed', () => {
    const old = {
      v: ADMIN_STATE_VERSION,
      admins: ['ada@example.invalid', 'grace@example.invalid']
      // No `managedAdmins` key at all — this is the shape every file had
      // before it. Absent reads as `[]`: the feature that would have put an
      // id there did not exist yet, so nothing is there because of it.
    }

    const migrated = adminStateOf(old)

    expect(migrated.admins).toEqual(['ada@example.invalid', 'grace@example.invalid'])
    expect(migrated.managedAdmins).toEqual([])
  })

  it('reads managedAdmins literally once the field exists, and intersects it with admins', () => {
    const raw = {
      v: ADMIN_STATE_VERSION,
      admins: ['ada@example.invalid', 'grace@example.invalid'],
      // Only grace is env-managed; ada is here some other way.
      managedAdmins: ['grace@example.invalid', 'somebody-not-an-admin@example.invalid']
    }

    const parsed = adminStateOf(raw)

    expect(parsed.admins).toEqual(['ada@example.invalid', 'grace@example.invalid'])
    // The id managedAdmins named that is not actually an administrator is
    // dropped — a hand-edited file cannot claim that provenance for somebody
    // who is not even on the list.
    expect(parsed.managedAdmins).toEqual(['grace@example.invalid'])
  })

  it('an empty admin state has nothing managed', () => {
    expect(emptyAdminState().managedAdmins).toEqual([])
  })
})
