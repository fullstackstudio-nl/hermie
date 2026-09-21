/**
 * `profiles.configure`'s `ui_meta` section, as the fake reproduces it.
 *
 * This is the only per-client scope the gateway offers — ADR-0012 was written
 * because nothing else on a profile row is a client's to write — so before
 * anything is stored in it the question "does a write REPLACE the bag or merge
 * into it" has to have an answer a test can point at.
 *
 * The answer is upstream's own docstring, which the generated contract carries
 * verbatim on `ProfilesConfigureParams`:
 *
 *   Sections are independent; ``ui_meta_expected_revisions`` is a per-key
 *   compare-and-swap.
 *
 * — together with the shapes it is stated in: `ui_meta_revisions` is a
 * `Record<string, number>` on both the profile row and the result, and
 * `ui_meta_conflicts` is a `Record<string, UiMetaConflict>`. A bag replaced
 * whole would have one revision, not one per key. So the unit is the TOP-LEVEL
 * KEY, and that is what the cases below pin.
 *
 * NOT verified against a running `hermes serve` in this round — see the note in
 * docs/adr/0016.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

/** One JSON-RPC round trip, so a case reads as the call it is about. */
async function withGateway<T>(run: (call: Call) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    try {
      return await run(callOn(socket))
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

function callOn(socket: WebSocket): Call {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as {
          id?: string
          result?: Record<string, unknown>
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

const metaOf = async (call: Call, name: string): Promise<Record<string, unknown>> => {
  const roster = (await call('profiles.list')) as { profiles?: { name: string; ui_meta?: Record<string, unknown> }[] }

  return roster.profiles?.find(row => row.name === name)?.ui_meta ?? {}
}

const revisionsOf = async (call: Call, name: string): Promise<Record<string, number>> => {
  const roster = (await call('profiles.list')) as {
    profiles?: { name: string; ui_meta_revisions?: Record<string, number> }[]
  }

  return roster.profiles?.find(row => row.name === name)?.ui_meta_revisions ?? {}
}

describe('profiles.configure ui_meta', () => {
  it('starts with the marker another tool put there', async () => {
    await withGateway(async call => {
      expect(await metaOf(call, 'researcher')).toEqual({ 'hermes-bots': {} })
    })
  })

  it('round-trips a key through profiles.list', async () => {
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 1, colour: 'teal' } } })

      expect(await metaOf(call, 'researcher')).toMatchObject({ hermie: { v: 1, colour: 'teal' } })
    })
  })

  it('leaves every key the write did not name exactly where it was', async () => {
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 1 } } })

      // The one that matters: `hermes-bots` is what makes a profile show up as a
      // bot at all, and it belongs to the desktop app. A client that wrote its
      // own key by replacing the bag would un-bot the profile it was colouring.
      expect(await metaOf(call, 'researcher')).toHaveProperty('hermes-bots')
    })
  })

  it('replaces the named key whole rather than merging into it', async () => {
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 1, colour: 'teal', old: true } } })
      await call('profiles.configure', {
        name: 'researcher',
        ui_meta: { hermie: { v: 1, colour: 'teal' } },
        ui_meta_expected_revisions: { hermie: 1 }
      })

      // A section is the unit, so the client owns the whole of its own key and
      // has to send the whole of it. Anything else would make removing a field
      // impossible.
      expect(await metaOf(call, 'researcher')).toMatchObject({ hermie: { v: 1, colour: 'teal' } })
      expect((await metaOf(call, 'researcher')).hermie).not.toHaveProperty('old')
    })
  })

  it('counts a revision per key, from zero', async () => {
    await withGateway(async call => {
      expect((await revisionsOf(call, 'researcher')).hermie).toBeUndefined()

      const first = (await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 1 } } })) as {
        applied?: { ui_meta_revisions?: Record<string, number> }
      }

      expect(first.applied?.ui_meta_revisions?.hermie).toBe(1)
      expect((await revisionsOf(call, 'researcher')).hermie).toBe(1)
    })
  })

  it('refuses a write whose expected revision is stale, and says what it found', async () => {
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { from: 'phone' } } })

      const late = (await call('profiles.configure', {
        name: 'researcher',
        ui_meta: { hermie: { from: 'desktop' } },
        ui_meta_expected_revisions: { hermie: 0 }
      })) as {
        applied?: { ui_meta?: boolean; ui_meta_conflicts?: Record<string, { expected: unknown; actual: number }> }
      }

      expect(late.applied?.ui_meta).toBe(false)
      expect(late.applied?.ui_meta_conflicts?.hermie).toEqual({ expected: 0, actual: 1 })
      // Refused means refused: the loser's value is not on the profile.
      expect(await metaOf(call, 'researcher')).toMatchObject({ hermie: { from: 'phone' } })
    })
  })

  it('applies the other sections of a request one of whose keys conflicts', async () => {
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { from: 'phone' } } })

      const mixed = (await call('profiles.configure', {
        name: 'researcher',
        ui_meta: { hermie: { from: 'desktop' }, 'hermie-app': { themes: ['lime'] } },
        ui_meta_expected_revisions: { hermie: 0, 'hermie-app': 0 }
      })) as { applied?: { ui_meta?: boolean; ui_meta_conflicts?: Record<string, unknown> } }

      expect(mixed.applied?.ui_meta).toBe(true)
      expect(Object.keys(mixed.applied?.ui_meta_conflicts ?? {})).toEqual(['hermie'])

      const meta = await metaOf(call, 'researcher')

      expect(meta).toMatchObject({ hermie: { from: 'phone' }, 'hermie-app': { themes: ['lime'] } })
    })
  })

  it('takes a write that names no expected revision at all', async () => {
    // The local-only fallback's other half: a client that has never read the
    // profile still has to be able to claim its key, and a blind write is how.
    await withGateway(async call => {
      await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 1 } } })

      const blind = (await call('profiles.configure', { name: 'researcher', ui_meta: { hermie: { v: 2 } } })) as {
        applied?: { ui_meta?: boolean }
      }

      expect(blind.applied?.ui_meta).toBe(true)
      expect(await metaOf(call, 'researcher')).toMatchObject({ hermie: { v: 2 } })
    })
  })

  it('refuses a profile it does not have rather than inventing one', async () => {
    await withGateway(async call => {
      await expect(call('profiles.configure', { name: 'nobody', ui_meta: { hermie: {} } })).rejects.toThrow(
        /Unknown profile/u
      )
    })
  })
})
