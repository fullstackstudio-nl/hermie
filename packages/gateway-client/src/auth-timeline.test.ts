import { describe, expect, it, vi } from 'vitest'

import { AuthTimeline, type AuthTimelineSnapshot } from './auth-timeline'

describe('AuthTimeline', () => {
  it('keeps only the most recent events', () => {
    const timeline = new AuthTimeline({ size: 3 })

    for (const event of ['dial.start', 'ticket.minted', 'dial.ready', 'ws.closed'] as const) {
      timeline.record({ event })
    }

    expect(timeline.snapshot().events.map(entry => entry.event)).toEqual(['ticket.minted', 'dial.ready', 'ws.closed'])
  })

  it('records the fields that carry a value and nothing else', () => {
    const timeline = new AuthTimeline({ now: () => 1_700_000_000_000 })

    timeline.record({ event: 'ws.closed', closeCode: 4401 })

    expect(timeline.snapshot().events[0]).toEqual({ at: 1_700_000_000_000, event: 'ws.closed', closeCode: 4401 })
  })

  it('hands the whole snapshot to the sink on every record', () => {
    const sink = vi.fn()
    const timeline = new AuthTimeline({ sink })

    timeline.record({ event: 'refresh.start' })
    timeline.record({ event: 'refresh.ok' })

    expect(sink).toHaveBeenCalledTimes(2)
    const last = sink.mock.calls[1]?.[0] as AuthTimelineSnapshot
    expect(last.events.map(entry => entry.event)).toEqual(['refresh.start', 'refresh.ok'])
  })

  it('survives a sink that throws, because recording a failure must not be one', () => {
    const timeline = new AuthTimeline({
      sink: () => {
        throw new Error('disk full')
      }
    })

    expect(() => timeline.record({ event: 'dial.start' })).not.toThrow()
    expect(timeline.snapshot().events).toHaveLength(1)
  })

  describe('signOut attribution', () => {
    it('reads back to the cause the coordinator recorded', () => {
      const timeline = new AuthTimeline()

      timeline.record({ event: 'dial.ready' })
      timeline.record({ event: 'ws.closed', closeCode: 4401 })
      timeline.record({ event: 'refresh.failed', kind: 'auth', status: 401 })
      timeline.record({ event: 'token.cleared', reason: 'refresh_rejected' })
      timeline.signOut('rejected_after_refresh')

      expect(timeline.signOutReason).toBe('refresh_rejected')
    })

    it('tells a transport failure apart from a rejected grant', () => {
      const timeline = new AuthTimeline()

      timeline.record({ event: 'refresh.failed', kind: 'network' })
      timeline.signOut('rejected_after_refresh')

      expect(timeline.signOutReason).toBe('refresh_failed')
    })

    it('blames an unreadable store when that is the last thing that happened', () => {
      const timeline = new AuthTimeline()

      timeline.record({ event: 'token.read_failed' })
      timeline.signOut('rejected_after_refresh')

      expect(timeline.signOutReason).toBe('token_unreadable')
    })

    /**
     * Anything older than the last healthy connection belongs to a different
     * story: a refresh that failed, was retried and succeeded must not be dug up
     * to explain a sign-out an hour later.
     */
    it('does not reach back past the last healthy dial', () => {
      const timeline = new AuthTimeline()

      timeline.record({ event: 'refresh.failed', kind: 'auth', status: 401 })
      timeline.record({ event: 'dial.ready' })
      timeline.record({ event: 'ws.closed', closeCode: 4401 })
      timeline.signOut('rejected_after_refresh')

      expect(timeline.signOutReason).toBe('rejected_after_refresh')
    })
  })

  describe('restore', () => {
    it('adopts a snapshot written before a restart', () => {
      const timeline = new AuthTimeline()

      timeline.restore({
        events: [{ at: 5, event: 'signin.required', reason: 'refresh_rejected' }],
        lastSignOut: { at: 5, reason: 'refresh_rejected' }
      })

      expect(timeline.signOutReason).toBe('refresh_rejected')
      expect(timeline.snapshot().events).toHaveLength(1)
    })

    it('drops entries an older build may have written in another shape', () => {
      const timeline = new AuthTimeline()

      timeline.restore({ events: ['dial.start', null, 42, { event: 'ws.closed' }, { at: 1, event: 'dial.ready' }] })

      expect(timeline.snapshot().events).toEqual([{ at: 1, event: 'dial.ready' }])
    })

    it('ignores a blob that is not a snapshot at all', () => {
      const timeline = new AuthTimeline()

      timeline.restore('signed out')
      timeline.restore(null)

      expect(timeline.snapshot()).toEqual({ events: [], lastSignOut: null })
    })
  })
})
