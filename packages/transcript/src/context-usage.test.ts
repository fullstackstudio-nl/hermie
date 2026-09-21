import { describe, expect, it } from 'vitest'

import { chatContextUsage, contextUsageOf, contextUsageOfInfo } from './context-usage'

describe('reading a context window', () => {
  it('reports the two numbers and the percentage between them', () => {
    expect(contextUsageOf({ context_max: 200_000, context_used: 50_000 })).toEqual({
      estimated: false,
      fraction: 0.25,
      limit: 200_000,
      percent: 25,
      used: 50_000
    })
  })

  it('carries the gateway’s own caveats through', () => {
    const usage = contextUsageOf({
      context_estimated: true,
      context_max: 128_000,
      context_source: 'model catalog',
      context_used: 64_000
    })

    expect(usage?.estimated).toBe(true)
    expect(usage?.source).toBe('model catalog')
  })

  it('has nothing to draw without a window size', () => {
    // The one case a table of model context sizes would have "fixed", and the
    // reason there is no such table: a guess here reads as room the session
    // does not have.
    expect(contextUsageOf({ context_used: 9_000, model: 'some-model' })).toBeNull()
    expect(contextUsageOf({ context_max: 0, context_used: 9_000 })).toBeNull()
    expect(contextUsageOf({ context_max: 200_000 })).toBeNull()
    expect(contextUsageOf({})).toBeNull()
    expect(contextUsageOf(null)).toBeNull()
    expect(contextUsageOf(undefined)).toBeNull()
  })

  it('refuses a figure that is not a finite count', () => {
    expect(contextUsageOf({ context_max: Number.NaN, context_used: 10 })).toBeNull()
    expect(contextUsageOf({ context_max: 100, context_used: -1 })).toBeNull()
    expect(contextUsageOf({ context_max: Number.POSITIVE_INFINITY, context_used: 10 })).toBeNull()
  })

  it('clamps a session that is momentarily over its window', () => {
    const usage = contextUsageOf({ context_max: 100, context_used: 140 })

    // The ring cannot draw past full; the count under it stays truthful.
    expect(usage?.fraction).toBe(1)
    expect(usage?.percent).toBe(100)
    expect(usage?.used).toBe(140)
  })

  it('ignores the gateway’s own percentage', () => {
    // `context_percent` is ambiguous between a fraction and a hundredth, and the
    // two cannot be told apart under one per cent. The ring and the label are
    // derived from the same division instead, so they cannot disagree.
    const usage = contextUsageOf({ context_max: 1000, context_percent: 0.9, context_used: 100 })

    expect(usage?.percent).toBe(10)
  })
})

describe('where a chat’s reading comes from', () => {
  it('prefers what the last event carried', () => {
    const state = {
      info: { usage: { context_max: 200_000, context_used: 10_000 } },
      usage: { context_max: 200_000, context_used: 90_000 }
    }

    expect(chatContextUsage(state)?.used).toBe(90_000)
  })

  it('falls back to the resume snapshot before any turn has run', () => {
    expect(chatContextUsage({ info: { usage: { context_max: 200_000, context_used: 10_000 } } })?.used).toBe(10_000)
  })

  it('does not take the larger of the two, because a compaction makes it smaller', () => {
    const state = {
      info: { usage: { context_max: 200_000, context_used: 180_000 } },
      usage: { context_max: 200_000, context_used: 12_000 }
    }

    expect(chatContextUsage(state)?.used).toBe(12_000)
  })

  it('has nothing to say about a chat that has never reported usage', () => {
    expect(chatContextUsage({})).toBeNull()
    expect(chatContextUsage(undefined)).toBeNull()
    expect(contextUsageOfInfo(undefined)).toBeNull()
    expect(contextUsageOfInfo({ model: 'x' })).toBeNull()
  })
})
