/**
 * What a bot is told about the person, from the store to the `ui_meta` bytes.
 *
 * `packages/gateway-client/src/context.test.ts` pins the projection against the
 * plugin's reader. This is the layer above it, and what is worth pinning here
 * is the part the plugin can never see: what the app decides NOT to write.
 *
 *  - **The device facts are sent without being asked about**, so "the first
 *    save" is not a moment the reader chooses. On a gateway with accounts the
 *    notice is what makes it one, and until it is accepted the section is
 *    absent — not empty, not partial, absent.
 *  - **A session-token gateway skips the notice**, because "everyone with
 *    access to this gateway" is the person holding the phone.
 *  - **The free text is off until somebody turns it on**, and a switch that is
 *    off has to keep the text out of the bytes rather than merely hiding the
 *    field.
 *  - **A gateway that names nobody still sends a name**, as far down the ladder
 *    in `effectiveDisplayName` as it has to go, because a real one answered
 *    `/api/auth/me` with a subject and nothing else.
 */
import { CONTEXT_LIMITS } from '@hermie/gateway-client/context'

import { keyValueStore } from '../src/platform/key-value-store'
import {
  DEVICE_CONTEXT_KEY,
  effectiveDisplayName,
  needsSharingNotice,
  ownContextRow,
  OWNER_USER_ID,
  useDeviceContextStore
} from '../src/store/device-context'
import { snapshotFromStores, type HermieAppShape } from '../src/store/ui-meta-bridge'

const NOW = 1_789_957_143
const GATEWAY = 'https://gateway.example'

const FACTS = {
  model: 'iPhone 17 Pro',
  os: 'iOS 27.0',
  appVersion: '0.1.0 (1284) · 7c838c4',
  timezone: 'Europe/Amsterdam',
  locale: 'nl-NL'
}

const store = () => useDeviceContextStore.getState()

/** Signed in on a gateway with accounts, with the device's facts already read. */
async function signedIn(
  patch: { gated?: boolean; userId?: string; displayName?: string; email?: string } = {}
): Promise<void> {
  await store().hydrate()
  store().setIdentity({
    baseUrl: GATEWAY,
    gated: patch.gated ?? true,
    userId: patch.userId ?? 'tester@example.invalid',
    displayName: patch.displayName ?? 'Sebas',
    email: patch.email ?? ''
  })
  store().refreshFacts(NOW, FACTS)
}

beforeEach(async () => {
  store().reset()
  await keyValueStore.delete(DEVICE_CONTEXT_KEY)
})

describe('the defaults', () => {
  it('share the name and open the free text, which starts empty', async () => {
    await store().hydrate()

    expect(store().shareDisplayName).toBe(true)
    expect(store().shareAbout).toBe(true)
    // The distinction that makes the switch above honest: on, over nothing.
    expect(store().about).toBe('')
  })

  it('send no free text at all until somebody writes some', async () => {
    await signedIn({ gated: false })

    expect(ownContextRow(store())).not.toHaveProperty('about')
  })
})

describe('the sharing notice', () => {
  it('stands on a gateway with accounts until it is accepted', async () => {
    await signedIn()

    expect(needsSharingNotice(store())).toBe(true)
    expect(ownContextRow(store())).toBeNull()

    store().acknowledge(GATEWAY)

    expect(needsSharingNotice(store())).toBe(false)
    expect(ownContextRow(store())).not.toBeNull()
  })

  it('writes nothing at all while it stands — not an empty section', async () => {
    await signedIn()

    expect(snapshotFromStores().app as HermieAppShape).not.toHaveProperty('context')
  })

  it('does not apply to a gateway with no accounts', async () => {
    await store().hydrate()
    store().setIdentity({ baseUrl: GATEWAY, gated: false, userId: OWNER_USER_ID, displayName: '', email: '' })
    store().refreshFacts(NOW, FACTS)

    expect(needsSharingNotice(store())).toBe(false)
    expect(ownContextRow(store())?.userId).toBe(OWNER_USER_ID)
  })

  it('is asked again on a different gateway', async () => {
    await signedIn()
    store().acknowledge(GATEWAY)
    store().setIdentity({
      baseUrl: 'https://other.example',
      gated: true,
      userId: 'tester@example.invalid',
      displayName: 'Sebas',
      email: ''
    })

    expect(needsSharingNotice(store())).toBe(true)
  })
})

/**
 * The bug Sebas hit on TestFlight: the switch read OFF on a gateway whose
 * `/api/auth/me` answers with a subject and neither a display name nor an
 * address, because it was being rendered from "the setting AND a name". The
 * setting is a decision and the name is a lookup, and these pin the lookup.
 */
describe('the name a bot is told', () => {
  const name = (patch: { displayName?: string; email?: string; userId?: string }): string =>
    effectiveDisplayName({ displayName: '', email: '', userId: '', ...patch })

  it('is the gateway’s own display name when there is one', () => {
    expect(name({ displayName: 'Sebas', email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('Sebas')
  })

  it('falls back to the local part of the address', () => {
    expect(name({ email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('sebas')
  })

  it('falls back last to the user id, with the provider prefix taken off', () => {
    expect(name({ userId: 'authentik:7f3a-ce10' })).toBe('7f3a-ce10')
  })

  it('leaves a subject that is a URL alone rather than cutting at its scheme', () => {
    expect(name({ userId: 'https://issuer.example/users/7f3a' })).toBe('https://issuer.example/users/7f3a')
  })

  it('shows the owner id of a gateway with no accounts as it is', () => {
    expect(name({ userId: OWNER_USER_ID })).toBe(OWNER_USER_ID)
  })

  it('is empty only when the gateway has named nobody at all', () => {
    expect(name({})).toBe('')
  })

  it('is cut at the cap the plugin renders with', () => {
    expect(name({ displayName: 'a'.repeat(200) })).toHaveLength(CONTEXT_LIMITS.displayName)
  })

  it('keeps the switch and the name apart: on, over a gateway that named nobody', async () => {
    await signedIn({ displayName: '', userId: '' })

    expect(store().shareDisplayName).toBe(true)
    expect(effectiveDisplayName(store())).toBe('')
  })
})

describe('the projection', () => {
  beforeEach(async () => {
    await signedIn()
    store().acknowledge(GATEWAY)
  })

  it('always carries the device, the timezone and the locale', () => {
    const app = snapshotFromStores().app as HermieAppShape
    const row = app.context?.users['tester@example.invalid'] as Record<string, unknown>

    expect(app.context).toMatchObject({ v: 1, default: 'tester@example.invalid' })
    expect(row).toMatchObject({
      displayName: 'Sebas',
      device: FACTS.model ? { model: FACTS.model, os: FACTS.os, appVersion: FACTS.appVersion } : {},
      timezone: 'Europe/Amsterdam',
      locale: 'nl-NL'
    })
  })

  it('sends the fallback name where the gateway supplied none', async () => {
    await signedIn({ displayName: '', email: 'sebas@example.invalid', userId: 'oidc:7f3a' })
    store().acknowledge(GATEWAY)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['oidc:7f3a']).toMatchObject({
      displayName: 'sebas'
    })
  })

  it('sends no name at all when even the user id is empty, with the switch still on', async () => {
    await signedIn({ displayName: '', userId: '' })
    store().acknowledge(GATEWAY)

    expect(store().shareDisplayName).toBe(true)
    // No identity means no row, so the section is not there to carry a name.
    expect(ownContextRow(store())).toBeNull()
    expect(snapshotFromStores().app as HermieAppShape).not.toHaveProperty('context')
  })

  it('leaves the name out when the switch is off', () => {
    store().setShareDisplayName(false, NOW)

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.context?.users['tester@example.invalid']).not.toHaveProperty('displayName')
  })

  it('sends the free text once there is some, and stops when the switch goes off', () => {
    store().setAbout('I maintain three Rust services.', NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).toMatchObject({
      about: 'I maintain three Rust services.'
    })

    store().setShareAbout(false, NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).not.toHaveProperty(
      'about'
    )
  })

  it('cuts the free text at the cap the plugin renders with', () => {
    store().setAbout('a'.repeat(2000), NOW)

    const row = (snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid'] as {
      about: string
    }

    expect(row.about).toHaveLength(CONTEXT_LIMITS.about)
  })

  it('keeps a per-bot note against that bot and removes it when it is emptied', () => {
    store().setBotNote('researcher', 'Cite your sources.', NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).toMatchObject({
      perBot: { researcher: 'Cite your sources.' }
    })

    store().setBotNote('researcher', '  ', NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).not.toHaveProperty(
      'perBot'
    )
  })

  it('carries another person’s row through untouched', () => {
    store().applyRemote({
      others: { 'colleague@example.invalid': { displayName: 'Robin', future: true } },
      remoteDefault: 'colleague@example.invalid'
    })

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.context?.users['colleague@example.invalid']).toEqual({ displayName: 'Robin', future: true })
  })
})

describe('the stamp', () => {
  it('is set the first time the facts are read, rather than left at the epoch', async () => {
    // Measured on the simulator: the section reached the gateway complete and
    // dated 1970, because nothing between `hydrate` and the first write ever
    // stamped it. The projection still reads no clock of its own.
    await store().hydrate()

    expect(store().updatedAt).toBeGreaterThan(1_700_000_000)
  })

  it('moves when the device’s own facts change, and not when they do not', async () => {
    await signedIn()
    store().refreshFacts(NOW, { ...FACTS, model: 'iPad Pro' })
    store().refreshFacts(NOW, FACTS)

    expect(store().updatedAt).toBe(NOW)

    store().refreshFacts(NOW + 60, FACTS)

    expect(store().updatedAt).toBe(NOW)

    store().refreshFacts(NOW + 60, { ...FACTS, appVersion: '0.2.0 (1300) · abcdef0' })

    expect(store().updatedAt).toBe(NOW + 60)
  })
})

describe('signing out', () => {
  it('forgets the identity, keeps the switches, and keeps everybody else’s rows', async () => {
    await signedIn()
    store().acknowledge(GATEWAY)
    store().setShareAbout(false, NOW)
    store().applyRemote({ others: { 'colleague@example.invalid': { displayName: 'Robin' } }, remoteDefault: '' })

    store().retire()

    expect(store().userId).toBe('')
    expect(store().shareAbout).toBe(false)
    expect(ownContextRow(store())).toBeNull()
    /*
      Theirs stays. The write that removes this person's row goes to the gateway
      being left, while the socket is still up, and a store that had already
      forgotten the others would send a section with nobody in it — the same way
      a Mac's push registration disappeared from the owner's gateway. They are
      dropped when the connection is, in `ChatRuntime`.
    */
    expect(store().others).toEqual({ 'colleague@example.invalid': { displayName: 'Robin' } })
  })
})

/**
 * One person, two devices, one row.
 *
 * The section is keyed by PERSON, so a desktop and a phone share a row rather
 * than getting one each — which is right, because there is one person, and
 * which is where both halves of the reported fault came from: a bot that went
 * on saying the owner was at their Mac while they typed on an iPad, and a new
 * chat whose frozen system-prompt section came out EMPTY although the block was
 * sitting in `profile.yaml` the whole time.
 */
describe('a second device', () => {
  /** The desktop's row, as the gateway holds it. */
  const REMOTE_ROW = {
    displayName: 'Sebas',
    device: { model: 'Mac', os: 'macOS · iOS 27.0', appVersion: '0.1.0 (1284) · 7c838c4' },
    timezone: 'Europe/Amsterdam',
    locale: 'nl-NL',
    updatedAt: NOW - 3600
  }

  /** What `applySnapshot` hands the store once it has read that gateway. */
  const fromGateway = (own: unknown = REMOTE_ROW): void =>
    store().applyRemote({ others: {}, remoteDefault: 'tester@example.invalid', own })

  /** Signed in, never asked the sharing question HERE, and still loading. */
  function arriving(): void {
    store().setIdentity({
      baseUrl: GATEWAY,
      gated: true,
      userId: 'tester@example.invalid',
      displayName: 'Sebas',
      email: ''
    })
  }

  it('says which machine it is, without asking a question already answered', async () => {
    /*
      The acknowledgement is kept on the device that gave it, so the phone had
      none — and until it had one `ownContextRow` answered `null` there, which
      is why an hour of typing on an iPad never moved a row that said Mac. The
      notice is about the GATEWAY, and the person's own row sitting on that
      gateway is them having answered it.
    */
    await signedIn()

    expect(store().acknowledgedFor).not.toBe(GATEWAY)

    fromGateway()

    expect(needsSharingNotice(store())).toBe(false)

    const row = (snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid'] as {
      device?: { model?: string }
    }

    // This device's facts, not the ones that were up there a moment ago.
    expect(row.device?.model).toBe(FACTS.model)
  })

  it('does not take the person out of the section while it is still loading', () => {
    /*
      The other half of the same report: a new chat froze an EMPTY section into
      its system prompt although the block was in `profile.yaml` the whole time.
      A reconcile can land before the disk read does, and a store that is not
      loaded has no row to write — while `foreignContextUsers` has already
      dropped this person's, on purpose, because the device is supposed to be
      replacing it. Between the two the section went out with the person
      missing from it, which is a deletion, because ADR-0016 writes it whole.
    */
    arriving()
    fromGateway()

    expect(ownContextRow(store())).toBeNull()
    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).toEqual(REMOTE_ROW)
  })

  it('carries a row it cannot read the same way', () => {
    // Written by a build this one has never heard of. Same rule as a
    // colleague's row: carried because of whose it is, not because it parses.
    arriving()
    fromGateway({ v: 9, somethingElse: true })

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).toEqual({
      v: 9,
      somethingElse: true
    })
  })

  it('writes no section at all when there is neither a row here nor one there', async () => {
    // The first device on a gateway with accounts, before the notice is
    // answered: absent, not empty, not partial. Unchanged by any of this.
    await store().hydrate()
    arriving()
    store().refreshFacts(NOW, FACTS)
    fromGateway(null)

    expect(needsSharingNotice(store())).toBe(true)
    expect((snapshotFromStores().app as HermieAppShape).context).toBeUndefined()
  })
})
