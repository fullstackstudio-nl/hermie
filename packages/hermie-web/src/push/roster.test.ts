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

  it('answers empty for a roster it cannot read at all', () => {
    expect(readRoster(null).bots).toEqual([])
    expect(readRoster({ profiles: 'nope' }).bots).toEqual([])
    expect(readRoster({ profiles: [{}, { name: '' }] }).bots).toEqual([])
    expect(
      readRoster({ profiles: [row({ is_default: true, ui_meta_revisions: { 'hermie-app': 'x' } })] }).appRevision
    ).toBe(0)
  })
})
