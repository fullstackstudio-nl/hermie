/**
 * The `ui_meta` client, against a running fake gateway.
 *
 * `packages/fake-gateway/src/ui-meta.test.ts` pins the PROTOCOL — that a write
 * leaves other keys alone, that revisions count per key, that a stale expected
 * revision is refused with `{ expected, actual }`. This suite is about the
 * CLIENT on top of it, and the four things ADR-0016 promises a reader:
 *
 *  1. a round trip: what one device writes, the next device reads;
 *  2. a conflict retried: a second writer between the read and the write does not
 *     cost the later writer their change;
 *  3. a write made with no gateway, and then synced when one appears;
 *  4. the marker `hermes-bots` still there afterwards — which is the one that
 *     would un-bot somebody's whole roster if it were ever false.
 *
 * It talks over a real socket rather than to a stub, because the question being
 * asked is whether this client and that protocol agree, and two stubs agreeing
 * with each other proves nothing.
 */
import { startFakeGateway } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import {
  BOT_MARKER_KEY,
  HERMIE_APP_KEY,
  HERMIE_KEY,
  UiMetaSync,
  type UiMetaGateway,
  type UiMetaSnapshot
} from './ui-meta'

/** One JSON-RPC round trip over a real socket, so a case reads as the call it is. */
function callOn(socket: WebSocket): UiMetaGateway['request'] {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as {
          id?: string
          result?: unknown
          error?: { message?: string }
        }

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

interface Harness {
  request: UiMetaGateway['request']
  /** A device: its own local copy, and a sync bound to it. */
  device: (initial?: UiMetaSnapshot) => { sync: UiMetaSync; local: UiMetaSnapshot }
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

    try {
      return await run({
        request,
        device(initial = { app: null, bots: {} }) {
          // The local copy is the thing the UI paints from; the sync only reads
          // it at the moment of a write and writes into it on a reconcile.
          const local: UiMetaSnapshot = { app: initial.app, bots: { ...initial.bots } }
          const sync = new UiMetaSync({
            gateway: { request },
            read: () => local,
            apply: snapshot => {
              local.app = snapshot.app
              local.bots = { ...snapshot.bots }
            }
          })

          return { sync, local }
        }
      })
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

const metaOf = async (request: UiMetaGateway['request'], name: string): Promise<Record<string, unknown>> => {
  const roster = (await request('profiles.list', {})) as {
    profiles?: { name: string; ui_meta?: Record<string, unknown> }[]
  }

  return roster.profiles?.find(row => row.name === name)?.ui_meta ?? {}
}

describe('one device writing', () => {
  it('sends a bot section and reads it back through profiles.list', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()

      phone.local.bots.researcher = { v: 1, archived: true, colour: 'lime' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      expect(await metaOf(request, 'researcher')).toMatchObject({
        [HERMIE_KEY]: { v: 1, archived: true, colour: 'lime' }
      })
      expect(phone.sync.pending).toBe(false)
      expect(phone.sync.mode).toBe('synced')
    })
  })

  it('leaves the marker another tool owns exactly where it was', async () => {
    // The one that matters. `hermes-bots` is what makes a profile show up as a
    // bot at all; a client that wrote its key by replacing the bag would un-bot
    // every profile it coloured.
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.bots.researcher = { v: 1, colour: 'teal' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta).toHaveProperty(BOT_MARKER_KEY)
      expect(Object.keys(meta).sort()).toEqual([BOT_MARKER_KEY, HERMIE_KEY].sort())
    })
  })

  it('puts the app-wide section on the DEFAULT profile, and nowhere else', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, order: ['writer', 'researcher'] }
      phone.sync.markApp()
      await phone.sync.flush()

      expect(await metaOf(request, 'researcher')).toHaveProperty(HERMIE_APP_KEY)
      expect(await metaOf(request, 'writer')).not.toHaveProperty(HERMIE_APP_KEY)
    })
  })
})

describe('a second device', () => {
  it('reads what the first one wrote', async () => {
    await withGateway(async ({ device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, dividers: ['Finance'] }
      phone.local.bots.writer = { v: 1, archived: true }
      phone.sync.markApp()
      phone.sync.markBot('writer')
      await phone.sync.flush()

      const desktop = device()

      await desktop.sync.reconcile()

      expect(desktop.local.app).toMatchObject({ dividers: ['Finance'] })
      expect(desktop.local.bots.writer).toMatchObject({ archived: true })
    })
  })

  it('ignores a section whose schema version it does not know', async () => {
    // A newer build's shape is not something to guess at: the reader keeps its
    // local copy rather than painting fields it cannot read.
    await withGateway(async ({ request, device }) => {
      await request('profiles.configure', {
        name: 'researcher',
        ui_meta: { [HERMIE_KEY]: { v: 99, colour: 'from-the-future' } }
      })

      const phone = device({ app: null, bots: { researcher: { v: 1, colour: 'teal' } } })

      await phone.sync.reconcile()

      expect(phone.local.bots.researcher).toBeUndefined()
    })
  })
})

describe('two devices at once', () => {
  it('retries a refused write with the revision that won, and lands', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()
      const desktop = device()

      // Both read the same revision …
      await phone.sync.reconcile()
      await desktop.sync.reconcile()

      // … the desktop writes first …
      desktop.local.bots.researcher = { v: 1, colour: 'teal' }
      desktop.sync.markBot('researcher')
      await desktop.sync.flush()

      // … and the phone, holding a revision that is now stale, writes anyway.
      phone.local.bots.researcher = { v: 1, colour: 'lime' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      // Last writer wins, per section. The phone was later, so the phone's
      // value is the one on the profile — and nothing was left dirty.
      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
      expect(phone.sync.pending).toBe(false)
    })
  })

  it('lands the sections of a request whose other section conflicts', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()
      const desktop = device()

      await phone.sync.reconcile()
      await desktop.sync.reconcile()

      desktop.local.app = { v: 1, order: ['writer'] }
      desktop.sync.markApp()
      await desktop.sync.flush()

      // The phone's app section is stale and its bot section is not; the bot
      // section goes to the same profile in the same request.
      phone.local.app = { v: 1, order: ['researcher'] }
      phone.local.bots.researcher = { v: 1, archived: true }
      phone.sync.markApp()
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta).toMatchObject({
        [HERMIE_KEY]: { archived: true },
        [HERMIE_APP_KEY]: { order: ['researcher'] }
      })
      expect(meta).toHaveProperty(BOT_MARKER_KEY)
    })
  })
})

describe('no gateway, and then one', () => {
  it('keeps a write local and sends it on the next reconcile', async () => {
    await withGateway(async ({ request }) => {
      const offline: UiMetaSnapshot = { app: null, bots: {} }
      const failing = new UiMetaSync({
        gateway: {
          request: () => Promise.reject(new Error('gateway not connected'))
        },
        read: () => offline,
        apply: snapshot => {
          offline.app = snapshot.app
          offline.bots = { ...snapshot.bots }
        }
      })

      offline.bots.researcher = { v: 1, colour: 'lime' }
      failing.markBot('researcher')

      expect(await failing.reconcile()).toBeNull()
      // The device's own copy is correct; the gateway's is not. That is the
      // ADR-0012 behaviour, still correct, rather than a degraded mode.
      expect(failing.mode).toBe('local')
      expect(failing.pending).toBe(true)
      expect(await metaOf(request, 'researcher')).not.toHaveProperty(HERMIE_KEY)

      // The same pending write, once a gateway is reachable.
      const back = new UiMetaSync({
        gateway: { request },
        read: () => offline,
        apply: () => {}
      })

      back.markBot('researcher')
      await back.reconcile()

      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
      expect(back.mode).toBe('synced')
      expect(back.pending).toBe(false)
    })
  })

  it('does not let a remote copy overwrite a change made while it was away', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.bots.researcher = { v: 1, colour: 'teal' }
      desktop.sync.markBot('researcher')
      await desktop.sync.flush()

      // The phone changed the same bot while it had no socket. Reconcile reads
      // the desktop's value, hands it over — and then sends the phone's, which
      // is still dirty.
      const phone = device({ app: null, bots: { researcher: { v: 1, colour: 'lime' } } })

      phone.sync.markBot('researcher')
      await phone.sync.reconcile()

      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
    })
  })
})
