/**
 * Two devices in one `ui_meta` section, against a running fake gateway.
 *
 * The report this exists for: on the owner's gateway,
 * `hermie-app.push.registrations` held exactly one row. A Mac had registered,
 * then a reinstalled iPhone registered, and the Mac's row was gone. Both
 * devices thought they were registered; only one of them was.
 *
 * ADR-0016 replaces a `ui_meta` key WHOLE and resolves a clash by last writer
 * wins, which is the right rule for the things in that key that are whole
 * values — an arrangement, a theme. It is the wrong rule for the two things in
 * it that are MAPS KEYED BY DEVICE: another phone's registration is not a rival
 * version of this phone's, and a write that does not carry it deletes it.
 *
 * So there are two ways to lose a neighbour and this suite has one case for
 * each:
 *
 *  1. **Writing from a copy that never had them.** The app hands the sync a
 *     local section built from the rows it last READ, and the reconcile hands
 *     the app back its own local section whenever it is holding an unsent
 *     change — which is precisely the state a device is in while it registers
 *     itself. The neighbours have to come off the gateway's own copy.
 *  2. **Winning a compare-and-swap with stale bytes.** Two devices that read
 *     the same revision and then both write: the loser is told the revision
 *     that won and used to re-send its own value against it, which is the
 *     protocol politely erasing the winner.
 *
 * The device below is deliberately the same shape as the app's own bridge — it
 * projects `others + own` on every read and takes `others` out of `apply` —
 * because a test double that merged differently would prove nothing about the
 * thing that broke.
 */
import { startFakeGateway } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import {
  foreignPushRows,
  pushSectionFor,
  pushSeenOf,
  type PushRegistrationInput,
  type PushSeenEntry,
  type PushType
} from './push'
import { appKeyFor, UiMetaSync, type UiMetaGateway, type UiMetaSnapshot } from './ui-meta'

const NOW = 1_789_957_143

/**
 * Two installations of ONE person, which is what this suite is about.
 *
 * The app-wide key carries the reader's name, so both devices write the same
 * one — a phone and a Mac belonging to the same person are exactly the case
 * where one must not unregister the other.
 */
const OWNER = 'owner'

const APP_KEY = appKeyFor(OWNER)

const ALL_TYPES: Record<PushType, boolean> = {
  message: true,
  request: true,
  cron: true,
  cron_done: true,
  cron_failed: true,
  turn_done: true,
  turn_failed: true
}

function callOn(socket: WebSocket): UiMetaGateway['request'] {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as { id?: string; result?: unknown; error?: { message?: string } }

        if (frame.id !== frameId) {
          return
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(new Error(frame.error.message ?? 'rpc error'))

          return
        }

        resolve(frame.result ?? {})
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })
}

/** One installation, projecting its section exactly as the app's bridge does. */
interface Device {
  sync: UiMetaSync
  /** Turn this installation's own registration on, or off with `null`. */
  set: (own: PushRegistrationInput | null) => void
}

interface Harness {
  request: UiMetaGateway['request']
  device: (installationId: string) => Device
  /** Every installation id currently in the section on the gateway. */
  registered: () => Promise<string[]>
}

async function withGateway<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const request = callOn(socket)

    const section = async (): Promise<Record<string, unknown>> => {
      const roster = (await request('profiles.list', {})) as {
        profiles?: { is_default?: boolean; ui_meta?: Record<string, unknown> }[]
      }
      const app = roster.profiles?.find(row => row.is_default === true)?.ui_meta?.[APP_KEY]

      return (app ?? {}) as Record<string, unknown>
    }

    try {
      return await run({
        request,
        registered: async () => {
          const push = (await section()).push as { registrations?: Record<string, unknown> } | undefined

          return Object.keys(push?.registrations ?? {}).sort()
        },
        device(installationId) {
          let others: Record<string, unknown> = {}
          let seen: Record<string, PushSeenEntry> = {}
          let own: PushRegistrationInput | null = null
          const local: UiMetaSnapshot = { app: null, bots: {} }

          const project = (): UiMetaSnapshot => {
            const pushSection = pushSectionFor({ others, own, seen, now: NOW })

            local.app = { v: 1, ...(pushSection ? { push: pushSection } : {}) }

            return local
          }

          const sync = new UiMetaSync({
            gateway: { request },
            read: project,
            apply: snapshot => {
              // The gateway's own copy, never the merged one: see the note at
              // the top, and `UiMetaSnapshot.remote`.
              const neighbours = snapshot.remote ?? snapshot.app

              others = foreignPushRows(neighbours, installationId)
              seen = pushSeenOf(neighbours)
              local.bots = { ...snapshot.bots }
              project()
            }
          })

          sync.setUser(OWNER)

          return {
            sync,
            set(next) {
              own = next
              sync.markApp()
            }
          }
        }
      })
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

const registration = (installationId: string, platform: string): PushRegistrationInput => ({
  installationId,
  address: { transport: 'expo', token: `ExponentPushToken[${installationId}]` },
  platform,
  types: { ...ALL_TYPES },
  preview: false,
  updatedAt: NOW
})

describe('two installations on one gateway', () => {
  it('both survive when they register one after the other', async () => {
    await withGateway(async ({ device, registered }) => {
      const mac = device('i-mac')

      await mac.sync.reconcile()
      mac.set(registration('i-mac', 'macos'))
      await mac.sync.flush()

      expect(await registered()).toEqual(['i-mac'])

      const phone = device('i-phone')

      // A fresh install: it has never read this gateway, so everything it knows
      // about the Mac has to come out of the reconcile it is about to do.
      phone.set(registration('i-phone', 'ios'))
      await phone.sync.reconcile()

      expect(await registered()).toEqual(['i-mac', 'i-phone'])
    })
  })

  it('both survive a registration made while the gateway was unread', async () => {
    // The shape the owner actually hit: the phone is already holding an unsent
    // change when it reconciles, so the reconcile hands it back its own local
    // section. A reader that took the neighbours out of THAT found none.
    await withGateway(async ({ device, registered }) => {
      const mac = device('i-mac')

      await mac.sync.reconcile()
      mac.set(registration('i-mac', 'macos'))
      await mac.sync.flush()

      const phone = device('i-phone')

      phone.set(registration('i-phone', 'ios'))
      await phone.sync.reconcile()
      await phone.sync.flush()

      expect(await registered()).toEqual(['i-mac', 'i-phone'])
    })
  })

  it('both survive a compare-and-swap the other device won', async () => {
    await withGateway(async ({ device, registered }) => {
      const mac = device('i-mac')
      const phone = device('i-phone')

      // Both read the SAME revision, then both write. One of them is refused
      // and has to fold in what won rather than re-sending its own bytes.
      await mac.sync.reconcile()
      await phone.sync.reconcile()

      mac.set(registration('i-mac', 'macos'))
      await mac.sync.flush()

      phone.set(registration('i-phone', 'ios'))
      await phone.sync.flush()

      expect(await registered()).toEqual(['i-mac', 'i-phone'])
      expect(phone.sync.pending).toBe(false)
    })
  })

  it('unregisters one device without touching the other', async () => {
    await withGateway(async ({ device, registered }) => {
      const mac = device('i-mac')
      const phone = device('i-phone')

      await mac.sync.reconcile()
      mac.set(registration('i-mac', 'macos'))
      await mac.sync.flush()

      await phone.sync.reconcile()
      phone.set(registration('i-phone', 'ios'))
      await phone.sync.flush()

      expect(await registered()).toEqual(['i-mac', 'i-phone'])

      // Signing out on the phone. Its own row goes; the Mac's is not the
      // phone's to remove.
      phone.set(null)
      await phone.sync.flush()

      expect(await registered()).toEqual(['i-mac'])
    })
  })

  it('keeps the other device’s heartbeat, which is the thing suppression reads', async () => {
    await withGateway(async ({ device, registered, request }) => {
      const mac = device('i-mac')

      await mac.sync.reconcile()
      mac.set(registration('i-mac', 'macos'))
      await mac.sync.flush()

      const phone = device('i-phone')

      phone.set(registration('i-phone', 'ios'))
      await phone.sync.reconcile()
      await phone.sync.flush()

      const roster = (await request('profiles.list', {})) as {
        profiles?: { is_default?: boolean; ui_meta?: Record<string, unknown> }[]
      }
      const app = roster.profiles?.find(row => row.is_default === true)?.ui_meta?.[APP_KEY]

      expect(await registered()).toEqual(['i-mac', 'i-phone'])
      // Nothing beat in this test, so the stamps are empty on both sides; what
      // is pinned here is that the SECTION survived rather than being replaced
      // by one device's idea of it.
      expect((app as { push?: { seen?: unknown } }).push?.seen).toEqual({})
    })
  })
})
