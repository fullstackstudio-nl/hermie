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
 */
import { CONTEXT_LIMITS } from '@hermie/gateway-client/context'

import { keyValueStore } from '../src/platform/key-value-store'
import {
  DEVICE_CONTEXT_KEY,
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
async function signedIn(patch: { gated?: boolean } = {}): Promise<void> {
  await store().hydrate()
  store().setIdentity({
    baseUrl: GATEWAY,
    gated: patch.gated ?? true,
    userId: 'tester@example.invalid',
    displayName: 'Sebas'
  })
  store().refreshFacts(NOW, FACTS)
}

beforeEach(async () => {
  store().reset()
  await keyValueStore.delete(DEVICE_CONTEXT_KEY)
})

describe('the defaults', () => {
  it('share the name and withhold the free text', async () => {
    await store().hydrate()

    expect(store().shareDisplayName).toBe(true)
    expect(store().shareAbout).toBe(false)
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
    store().setIdentity({ baseUrl: GATEWAY, gated: false, userId: OWNER_USER_ID, displayName: '' })
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
      displayName: 'Sebas'
    })

    expect(needsSharingNotice(store())).toBe(true)
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

  it('leaves the name out when the switch is off', () => {
    store().setShareDisplayName(false, NOW)

    const app = snapshotFromStores().app as HermieAppShape

    expect(app.context?.users['tester@example.invalid']).not.toHaveProperty('displayName')
  })

  it('leaves the free text out while the switch is off, even with text in it', () => {
    store().setAbout('I maintain three Rust services.', NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).not.toHaveProperty(
      'about'
    )

    store().setShareAbout(true, NOW)

    expect((snapshotFromStores().app as HermieAppShape).context?.users['tester@example.invalid']).toMatchObject({
      about: 'I maintain three Rust services.'
    })
  })

  it('cuts the free text at the cap the plugin renders with', () => {
    store().setShareAbout(true, NOW)
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
  it('moves when the device’s own facts change, and not when they do not', async () => {
    await signedIn()

    expect(store().updatedAt).toBe(NOW)

    store().refreshFacts(NOW + 60, FACTS)

    expect(store().updatedAt).toBe(NOW)

    store().refreshFacts(NOW + 60, { ...FACTS, appVersion: '0.2.0 (1300) · abcdef0' })

    expect(store().updatedAt).toBe(NOW + 60)
  })
})

describe('signing out', () => {
  it('forgets the identity and the neighbours, and keeps the reader’s own switches', async () => {
    await signedIn()
    store().acknowledge(GATEWAY)
    store().setShareAbout(true, NOW)
    store().applyRemote({ others: { 'colleague@example.invalid': {} }, remoteDefault: '' })

    store().retire()

    expect(store().userId).toBe('')
    expect(store().others).toEqual({})
    expect(store().shareAbout).toBe(true)
    expect(ownContextRow(store())).toBeNull()
  })
})
