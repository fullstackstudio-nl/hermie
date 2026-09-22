/**
 * The daemon leaving a note saying it exists.
 *
 * Every case here is about what the note must NOT take with it. `hermie-app` is
 * one `ui_meta` key and ADR-0016 replaces a key WHOLE, so this write carries the
 * chat list's order, the dividers, the archive, every chat's colour, the theme,
 * and the registrations and heartbeats the devices themselves wrote. A daemon
 * that sent only its own four fields would delete all of it.
 */
import { describe, expect, it, vi } from 'vitest'

import { announceAvailability, availabilityIsCurrent, withAvailability, type PushAvailability } from './announce'
import type { Roster } from './roster'

const AVAILABILITY: PushAvailability = {
  endpoint: '/push/vapid-public-key',
  vapidPublicKey: 'BKxx',
  version: '1.2.3',
  at: 1_800_000_000
}

const roster = (over: Partial<Roster> = {}): Roster => ({
  bots: [],
  defaultProfile: 'researcher',
  appSection: null,
  appRevision: 0,
  push: { registrations: [], seen: {} },
  ...over
})

describe('building the bag', () => {
  it('keeps every neighbouring key, which is the whole risk of this write', () => {
    const written = withAvailability(
      {
        v: 1,
        theme: 'lime',
        order: ['researcher', 'writer'],
        push: { registrations: { 'dev-1': { transport: 'expo' } }, seen: { 'dev-1': 99 } }
      },
      AVAILABILITY
    )

    expect(written.theme).toBe('lime')
    expect(written.order).toEqual(['researcher', 'writer'])

    const push = written.push as Record<string, unknown>

    // The devices' own half of `push` is not the daemon's to rewrite.
    expect(push.registrations).toEqual({ 'dev-1': { transport: 'expo' } })
    expect(push.seen).toEqual({ 'dev-1': 99 })
    expect(push.endpoint).toBe('/push/vapid-public-key')
    expect(push.vapidPublicKey).toBe('BKxx')
    expect(push.version).toBe('1.2.3')
    expect(push.at).toBe(1_800_000_000)
  })

  it('gives a bag that has never been written the section version the app checks', () => {
    expect(withAvailability(null, AVAILABILITY).v).toBe(1)
    expect(withAvailability({ v: 2, x: 1 }, AVAILABILITY).v).toBe(2)
  })

  it('knows when the stored note already says this', () => {
    const current = withAvailability(null, AVAILABILITY)

    expect(availabilityIsCurrent(current, { ...AVAILABILITY, at: AVAILABILITY.at + 10 }, 300)).toBe(true)
    // The stamp is a liveness claim, so it goes stale on its own.
    expect(availabilityIsCurrent(current, { ...AVAILABILITY, at: AVAILABILITY.at + 400 }, 300)).toBe(false)
    expect(availabilityIsCurrent(current, { ...AVAILABILITY, vapidPublicKey: 'other' }, 300)).toBe(false)
    expect(availabilityIsCurrent(null, AVAILABILITY, 300)).toBe(false)
  })
})

describe('writing it', () => {
  it('is a compare-and-swap on the one key, at the revision it was read at', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const link = {
      async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push({ method, params })

        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermie-app': 8 } } } as T
      }
    }

    const result = await announceAvailability(link, roster({ appRevision: 7 }), AVAILABILITY)

    expect(result).toEqual({ written: true, revision: 8 })
    expect(calls[0]?.params.ui_meta_expected_revisions).toEqual({ 'hermie-app': 7 })
    // Only the key it owns. A write naming a second key would be a claim on
    // something another tool put there.
    expect(Object.keys(calls[0]?.params.ui_meta as object)).toEqual(['hermie-app'])
  })

  it('re-reads on a conflict, so it does not write over the value that won', async () => {
    const link = {
      request: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === 'profiles.list') {
          return {
            profiles: [
              {
                name: 'researcher',
                is_default: true,
                ui_meta: { 'hermie-app': { v: 1, theme: 'graphite', push: { seen: { 'dev-9': 5 } } } },
                ui_meta_revisions: { 'hermie-app': 9 }
              }
            ]
          }
        }

        const attempt = link.request.mock.calls.filter(call => call[0] === 'profiles.configure').length

        return attempt === 1
          ? { applied: { ui_meta_conflicts: { 'hermie-app': { expected: 7, actual: 9 } } } }
          : { applied: { ui_meta_revisions: { 'hermie-app': 10 } } }
      })
    }

    const result = await announceAvailability(link as never, roster({ appRevision: 7 }), AVAILABILITY)

    expect(result).toEqual({ written: true, revision: 10 })

    const second = link.request.mock.calls.filter(call => call[0] === 'profiles.configure')[1]?.[1] as Record<
      string,
      unknown
    >
    const bag = (second.ui_meta as Record<string, Record<string, unknown>>)['hermie-app'] ?? {}

    // The value that won is carried into the retry, not overwritten by it.
    expect(bag.theme).toBe('graphite')
    expect((bag.push as Record<string, unknown>).seen).toEqual({ 'dev-9': 5 })
    expect(second.ui_meta_expected_revisions).toEqual({ 'hermie-app': 9 })
  })

  it('gives up after one retry rather than spinning against a busy writer', async () => {
    const link = {
      request: vi.fn(async (method: string) =>
        method === 'profiles.list'
          ? { profiles: [{ name: 'researcher', is_default: true }] }
          : { applied: { ui_meta_conflicts: { 'hermie-app': { expected: 1, actual: 2 } } } }
      )
    }

    expect(await announceAvailability(link as never, roster(), AVAILABILITY)).toEqual({ written: false, revision: 2 })
    expect(link.request.mock.calls.filter(call => call[0] === 'profiles.configure')).toHaveLength(2)
  })

  it('writes nothing when the gateway has no default profile to write it on', async () => {
    const link = { request: vi.fn() }

    expect(await announceAvailability(link as never, roster({ defaultProfile: '' }), AVAILABILITY)).toEqual({
      written: false,
      revision: 0
    })
    expect(link.request).not.toHaveBeenCalled()
  })
})
