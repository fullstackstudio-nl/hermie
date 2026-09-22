/**
 * `GET /api/sessions/search`, pinned against `sessions.py::search_sessions`.
 *
 * The three properties the app is built on are all negative ones — the route is
 * per profile, it answers one hit per conversation, and a hit names no message —
 * so they are asserted here rather than left to be rediscovered by whoever next
 * wonders why the search result cannot scroll to a row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFakeGateway, type FakeGateway } from './server'

let gateway: FakeGateway

const search = async (query: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${gateway.url}/api/sessions/search?${query}`)

  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

const resultsOf = async (query: string): Promise<Record<string, unknown>[]> =>
  (await search(query)).body.results as Record<string, unknown>[]

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
})

afterAll(async () => {
  await gateway.close()
})

describe('the envelope', () => {
  it('wraps the hits in `results`', async () => {
    const body = (await search('q=introduce')).body

    expect(Object.keys(body)).toEqual(['results'])
    expect(Array.isArray(body.results)).toBe(true)
  })

  it('answers an empty list for a blank query, rather than every session', async () => {
    expect(await resultsOf('q=')).toEqual([])
    expect(await resultsOf('q=%20%20')).toEqual([])
  })
})

describe('the hit', () => {
  it('names the session, not the message', async () => {
    const [hit] = await resultsOf('q=introduce')

    expect(typeof hit?.session_id).toBe('string')
    // `search_sessions` projects (session_id, role, snippet, source, model,
    // session_started) and merges the rich SESSION row onto it. Neither half
    // carries the message's row id or its timestamp, although
    // `SessionDB.search_messages` can return both. A client that scrolls to a
    // row has to find that row itself.
    expect(hit).not.toHaveProperty('message_id')
    expect(hit).not.toHaveProperty('row_id')
    expect(hit).not.toHaveProperty('timestamp')
  })

  it('wraps the matched run in the marker pair the snippet function uses', async () => {
    const [hit] = await resultsOf('q=introduce')

    expect(String(hit?.snippet)).toMatch(/>>>[Ii]ntroduce<<</)
  })

  it('matches a partial word, because upstream appends `*` to a bare term', async () => {
    expect(await resultsOf('q=introd')).not.toHaveLength(0)
  })

  it('requires every term to land in the same message', async () => {
    // Both words are in the roster, in different messages, and the implicit
    // FTS5 operator is AND over one indexed row.
    expect(await resultsOf('q=introduce%20service')).toEqual([])
  })
})

describe('the scope', () => {
  it('searches one profile at a time', async () => {
    const all = await resultsOf('q=introduce')
    const one = await resultsOf('q=introduce&profile=writer')

    expect(all.length).toBeGreaterThan(1)
    expect(one).toHaveLength(1)
  })

  it('404s an unknown profile, the way `_cron_profile_home` does', async () => {
    // Not an empty result: the fan-out over a roster has to survive a profile
    // the gateway does not have, and a 404 is what it will actually meet.
    expect((await search('q=introduce&profile=nobody')).status).toBe(404)
  })
})

describe('the collapse', () => {
  it('answers at most one hit per conversation', async () => {
    // "one" appears in more than one message of the seeded chat.
    const hits = await resultsOf('q=one&profile=researcher')

    expect(hits).toHaveLength(1)
  })

  it('clamps the limit to at least one', async () => {
    expect((await resultsOf('q=introduce&limit=0')).length).toBeGreaterThan(0)
    expect(await resultsOf('q=introduce&limit=1')).toHaveLength(1)
  })
})
