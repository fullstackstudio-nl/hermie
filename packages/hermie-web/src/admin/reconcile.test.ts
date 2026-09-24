import { describe, expect, it } from 'vitest'

import { setAccountRole } from '../oidc/accounts'
import { emptyOidcState, oidcStateOf, type OidcState } from '../oidc/state'
import type { OidcUser } from '../oidc/users'
import { reconcileAdminAndIssuer } from './reconcile'
import { emptyAdminState, type AdminState } from './state'

const OWNER = 'sub-owner'
const BOSS = 'sub-boss'

function account(sub: string, role: 'admin' | 'user'): OidcUser {
  return {
    sub,
    username: sub.replace('sub-', ''),
    email: '',
    displayName: '',
    role,
    totpSecret: '',
    recoveryCodes: [],
    disabled: false,
    createdAt: 0,
    lastSignInAt: 0
  }
}

const issuer = (...users: OidcUser[]): OidcState => ({ ...emptyOidcState(), enabled: true, users })
const admins = (over: Partial<AdminState> = {}): AdminState => ({ ...emptyAdminState(), ...over })

/** Run one start: the state it would write, as plain JSON the next start would read back. */
function start(admin: AdminState, oidc: OidcState, env: string[]) {
  const result = reconcileAdminAndIssuer(admin, oidc, env)

  return { ...result, oidc: JSON.parse(JSON.stringify(result.oidc)) as OidcState }
}

describe('reconcileAdminAndIssuer', () => {
  it('raises a named id’s role, and gives it back once the container stops naming it (the ratchet probe)', () => {
    const named = start(admins(), issuer(account(OWNER, 'user'), account(BOSS, 'admin')), [OWNER])

    expect(named.admin.admins).toEqual([BOSS, OWNER].sort())
    expect(named.admin.managedAdmins).toEqual([OWNER])
    expect(named.oidc.users.find(user => user.sub === OWNER)).toMatchObject({ role: 'admin', roleFromEnv: true })

    const dropped = start(named.admin, named.oidc, [])

    expect(dropped.admin.admins).toEqual([BOSS])
    expect(dropped.admin.managedAdmins).toEqual([])
    expect(dropped.oidc.users.find(user => user.sub === OWNER)?.role).toBe('user')
    expect(dropped.oidc.users.find(user => user.sub === OWNER)?.roleFromEnv).toBeUndefined()
    expect(dropped.kept).toEqual([])

    // And a third start changes nothing further.
    const again = reconcileAdminAndIssuer(dropped.admin, dropped.oidc, [])

    expect(again.admin).toBe(dropped.admin)
    expect(again.oidc).toBe(dropped.oidc)
  })

  it('never marks a role that was already admin, so dropping the id leaves it alone', () => {
    const named = start(admins(), issuer(account(BOSS, 'admin')), [BOSS])

    expect(named.oidc.users[0]?.roleFromEnv).toBeUndefined()

    const dropped = start(named.admin, named.oidc, [])

    expect(dropped.oidc.users[0]?.role).toBe('admin')
    expect(dropped.admin.admins).toEqual([BOSS])
  })

  it('keeps a role a person set to admin while the container named the id', () => {
    const named = start(admins(), issuer(account(OWNER, 'user'), account(BOSS, 'admin')), [OWNER])
    const claimed = setAccountRole(named.oidc, OWNER, 'admin')

    expect(claimed.users.find(user => user.sub === OWNER)?.roleFromEnv).toBeUndefined()

    const dropped = start(named.admin, claimed, [])

    expect(dropped.oidc.users.find(user => user.sub === OWNER)?.role).toBe('admin')
    expect(dropped.admin.admins).toEqual([BOSS, OWNER].sort())
  })

  it('never demotes the last way into /admin, and says which id it kept and why', () => {
    const named = start(admins(), issuer(account(OWNER, 'user')), [OWNER])

    expect(named.admin.admins).toEqual([OWNER])

    const dropped = start(named.admin, named.oidc, [])

    expect(dropped.admin.admins).toEqual([OWNER])
    // Still marked and still managed, so a later start can let it go.
    expect(dropped.oidc.users[0]).toMatchObject({ role: 'admin', roleFromEnv: true })
    expect(dropped.admin.managedAdmins).toEqual([OWNER])
    expect(dropped.kept.map(entry => entry.id)).toEqual([OWNER])
    expect(dropped.kept[0]?.reason).toMatch(/last way into \/admin/)

    // Once somebody else can get in, the next start lets it go.
    const withBoss = start(
      dropped.admin,
      { ...dropped.oidc, users: [...dropped.oidc.users, account(BOSS, 'admin')] },
      []
    )

    expect(withBoss.admin.admins).toEqual([BOSS])
    expect(withBoss.admin.managedAdmins).toEqual([])
    expect(withBoss.oidc.users.find(user => user.sub === OWNER)?.role).toBe('user')
    expect(withBoss.kept).toEqual([])
  })

  it('lets the last env-named administrator go when a local secret is a way in', () => {
    const named = start(admins({ localAdmin: { salt: 's', hash: 'h' } }), issuer(account(OWNER, 'user')), [OWNER])
    const dropped = start(named.admin, named.oidc, [])

    expect(dropped.admin.admins).toEqual([])
    expect(dropped.oidc.users[0]?.role).toBe('user')
    expect(dropped.kept).toEqual([])
  })

  it('waits while the provider is off, rather than demote where the last-way check cannot see', () => {
    const named = start(admins(), issuer(account(OWNER, 'user')), [OWNER])
    const off = start(named.admin, { ...named.oidc, enabled: false }, [])

    expect(off.oidc.users[0]).toMatchObject({ role: 'admin', roleFromEnv: true })
    expect(off.admin.admins).toEqual([OWNER])
  })

  it('reports an env-only administrator with no issuer account kept as the last one too', () => {
    const named = start(admins(), issuer(), ['plain-user'])
    const dropped = start(named.admin, named.oidc, [])

    expect(dropped.admin.admins).toEqual(['plain-user'])
    expect(dropped.kept).toEqual([{ id: 'plain-user', reason: expect.stringMatching(/last way into \/admin/) }])
  })
})

describe('roleFromEnv on disk', () => {
  it('reads back only beside an admin role', () => {
    const parsed = oidcStateOf({
      ...JSON.parse(JSON.stringify(issuer(account(OWNER, 'admin'), account(BOSS, 'user')))),
      users: [
        { ...account(OWNER, 'admin'), roleFromEnv: true },
        { ...account(BOSS, 'user'), roleFromEnv: true }
      ]
    })

    expect(parsed.users.find(user => user.sub === OWNER)?.roleFromEnv).toBe(true)
    expect(parsed.users.find(user => user.sub === BOSS)?.roleFromEnv).toBeUndefined()
  })
})
