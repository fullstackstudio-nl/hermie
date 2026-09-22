/**
 * What one `profiles.list` tells the daemon.
 *
 * All of it is read defensively, because a roster row is JSON off a wire. The
 * case worth naming is `resolved_id`: a chat that has been compressed lives on
 * under a new id, and a daemon that resumed the registry row would attach to the
 * wrong end of it and hear nothing.
 */
import { describe, expect, it } from 'vitest'

import { PUSH_SECTION_VERSION } from './registrations'
import { readRoster } from './roster'

const row = (over: Record<string, unknown> = {}) => ({
  name: 'researcher',
  display_name: 'Researcher',
  canonical_session: { id: 'stored-r', resolved_id: 'live-r' },
  ...over
})

/** One readable registration, dated, for the cases about which row wins. */
const device = (updatedAt: number) => ({
  v: PUSH_SECTION_VERSION,
  transport: 'expo',
  token: 'ExponentPushToken[x]',
  platform: 'ios',
  types: { message: true },
  updatedAt
})

describe('reading the roster', () => {
  it('names the live compression tip, and keeps the registry row beside it', () => {
    const roster = readRoster({ profiles: [row()] })

    expect(roster.bots[0]).toEqual({
      name: 'researcher',
      label: 'Researcher',
      sessionId: 'live-r',
      storedId: 'stored-r'
    })
  })

  it('falls back to the registry row when the gateway resolves nothing', () => {
    expect(readRoster({ profiles: [row({ canonical_session: { id: 'stored-r' } })] }).bots[0]?.sessionId).toBe(
      'stored-r'
    )
  })

  it('skips a profile with no Bot Chat, because there is nothing to watch', () => {
    expect(readRoster({ profiles: [row({ canonical_session: null })] }).bots).toHaveLength(0)
  })

  it('takes the registrations off the default profile only', () => {
    const roster = readRoster({
      profiles: [
        row({ name: 'writer', ui_meta: { 'hermie-app': { v: 1, push: { registrations: { spoof: {} } } } } }),
        row({
          is_default: true,
          ui_meta: {
            'hermie-app': {
              v: 1,
              push: {
                registrations: {
                  'dev-1': {
                    v: PUSH_SECTION_VERSION,
                    transport: 'expo',
                    token: 'ExponentPushToken[x]',
                    platform: 'ios',
                    types: { message: true },
                    updatedAt: 1
                  }
                },
                seen: { 'dev-1': 42 }
              }
            }
          },
          ui_meta_revisions: { 'hermie-app': 7 }
        })
      ]
    })

    expect(roster.defaultProfile).toBe('researcher')
    expect(roster.appRevision).toBe(7)
    expect(roster.push.registrations.map(entry => entry.installationId)).toEqual(['dev-1'])
    expect(roster.push.seen['dev-1']).toBe(42)
  })

  it('hands back the whole app bag, so a write can be a read-modify-write', () => {
    const roster = readRoster({
      profiles: [row({ is_default: true, ui_meta: { 'hermie-app': { v: 1, theme: 'lime', push: {} } } })]
    })

    expect(roster.appSection).toEqual({ v: 1, theme: 'lime', push: {} })
  })

  it('pools the registrations of every person on the gateway', () => {
    // The app writes one key per person now. A notifier's job is to reach every
    // device that asked, and which person's key a device wrote itself into is
    // not its business.
    const roster = readRoster({
      profiles: [
        row({
          is_default: true,
          ui_meta: {
            'hermie-app:alice': { v: 1, push: { registrations: { 'dev-a': device(1) }, seen: { 'dev-a': 10 } } },
            'hermie-app:bob': { v: 1, push: { registrations: { 'dev-b': device(1) }, seen: { 'dev-b': 20 } } }
          }
        })
      ]
    })

    expect(roster.push.registrations.map(entry => entry.installationId)).toEqual(['dev-a', 'dev-b'])
    expect(roster.push.seen).toEqual({ 'dev-a': 10, 'dev-b': 20 })
  })

  it('notifies a device that sits in two keys exactly once', () => {
    // The failure this exists to stop. One phone, signed in on a gateway that
    // once held an anonymous arrangement, can be named twice; sending twice is
    // the one thing a notifier must not do.
    const roster = readRoster({
      profiles: [
        row({
          is_default: true,
          ui_meta: {
            'hermie-app:alice': { v: 1, push: { registrations: { 'dev-a': device(9) } } },
            'hermie-app:bob': { v: 1, push: { registrations: { 'dev-a': device(4) } } }
          }
        })
      ]
    })

    expect(roster.push.registrations).toHaveLength(1)
    // The newest row wins: that is the token most recently proved.
    expect(roster.push.registrations[0]?.updatedAt).toBe(9)
  })

  it('takes the latest heartbeat when two keys mention the same device', () => {
    const roster = readRoster({
      profiles: [
        row({
          is_default: true,
          ui_meta: {
            'hermie-app:alice': { v: 1, push: { seen: { 'dev-a': 10 } } },
            'hermie-app:bob': { v: 1, push: { seen: { 'dev-a': 99 } } }
          }
        })
      ]
    })

    expect(roster.push.seen['dev-a']).toBe(99)
  })

  it('reads the legacy key only while nobody has one of their own', () => {
    // A fallback, not a second source: pooling both would send to a migrated
    // device twice, once for its new row and once for the one it left behind.
    const both = readRoster({
      profiles: [
        row({
          is_default: true,
          ui_meta: {
            'hermie-app': { v: 1, push: { registrations: { stale: device(1) } } },
            'hermie-app:alice': { v: 1, push: { registrations: { 'dev-a': device(2) } } }
          }
        })
      ]
    })

    expect(both.push.registrations.map(entry => entry.installationId)).toEqual(['dev-a'])

    const legacyOnly = readRoster({
      profiles: [
        row({ is_default: true, ui_meta: { 'hermie-app': { v: 1, push: { registrations: { old: device(1) } } } } })
      ]
    })

    expect(legacyOnly.push.registrations.map(entry => entry.installationId)).toEqual(['old'])
  })

  it('answers empty for a roster it cannot read at all', () => {
    expect(readRoster(null).bots).toEqual([])
    expect(readRoster({ profiles: 'nope' }).bots).toEqual([])
    expect(readRoster({ profiles: [{}, { name: '' }] }).bots).toEqual([])
    expect(
      readRoster({ profiles: [row({ is_default: true, ui_meta_revisions: { 'hermie-app': 'x' } })] }).appRevision
    ).toBe(0)
  })
})
