/**
 * The search client, over a real `GatewayHttp` against a running fake gateway.
 *
 * `packages/fake-gateway/src/session-search.test.ts` pins the ROUTE. This is
 * about the reader on top of it: the URL it builds, the clamp it applies before
 * the server's own, the rows it refuses, and the two snippet functions the UI
 * renders with.
 */
import { startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialProvider } from './credentials'
import { GatewayHttp } from './http'
import {
  parseSessionSearch,
  plainSnippet,
  searchSessions,
  SESSION_SEARCH_LIMIT_CAP,
  snippetSegments,
  type SessionSearchHttp
} from './session-search'

const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

let gateway: Awaited<ReturnType<typeof startFakeGateway>>
let http: GatewayHttp

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
  http = new GatewayHttp({ baseUrl: gateway.url, credentials: anonymous })
})

afterAll(async () => {
  await gateway.close()
})

/** An http seam that only records the path it was asked for. */
function recording(): { paths: string[]; http: SessionSearchHttp } {
  const paths: string[] = []

  return {
    http: {
      get: (async (path: string) => {
        paths.push(path)

        return { results: [] }
      }) as SessionSearchHttp['get']
    },
    paths
  }
}

describe('the request', () => {
  it('never leaves the device for a blank query', async () => {
    const seam = recording()

    expect(await searchSessions(seam.http, { query: '   ' })).toEqual([])
    expect(seam.paths).toEqual([])
  })

  it('names the profile it is searching, because the route is per profile', async () => {
    const seam = recording()

    await searchSessions(seam.http, { limit: 5, profile: 'writer', query: 'invoice' })

    expect(seam.paths[0]).toBe('/api/sessions/search?q=invoice&limit=5&profile=writer')
  })

  it('clamps the limit to the server’s own range before asking', async () => {
    const seam = recording()

    await searchSessions(seam.http, { limit: 5000, query: 'x' })
    await searchSessions(seam.http, { limit: 0, query: 'x' })

    expect(seam.paths[0]).toContain(`limit=${SESSION_SEARCH_LIMIT_CAP}`)
    expect(seam.paths[1]).toContain('limit=1')
  })
})

describe('against the fake gateway', () => {
  it('reads a hit the route really produced', async () => {
    const hits = await searchSessions(http, { profile: 'researcher', query: 'introduce' })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toMatch(/^stored-researcher-/)
    expect(hits[0]?.snippet).toContain('>>>')
    expect(typeof hits[0]?.at).toBe('number')
  })

  it('answers nothing for a profile the gateway does not have, without throwing the fan-out over', async () => {
    // A 404 is a `GatewayError`, and the caller (one bot of many) has to be able
    // to drop that bot rather than lose every other bot's results with it.
    await expect(searchSessions(http, { profile: 'nobody', query: 'introduce' })).rejects.toThrow()
  })
})

describe('reading a row', () => {
  it('drops a row that names no session', () => {
    expect(parseSessionSearch({ results: [{ snippet: 'orphan' }, { session_id: 's1', snippet: 'kept' }] })).toEqual([
      { archived: false, sessionId: 's1', snippet: 'kept' }
    ])
  })

  it('answers nothing for a body that is not a search answer', () => {
    expect(parseSessionSearch(null)).toEqual([])
    expect(parseSessionSearch({ detail: 'Search failed' })).toEqual([])
    expect(parseSessionSearch({ results: 'no' })).toEqual([])
  })

  it('prefers `last_active`, then `started_at`, then the hit’s own session stamp', () => {
    const at = (row: Record<string, unknown>): number | undefined =>
      parseSessionSearch({ results: [{ session_id: 's', ...row }] })[0]?.at

    expect(at({ last_active: 3, session_started: 1, started_at: 2 })).toBe(3)
    expect(at({ session_started: 1, started_at: 2 })).toBe(2)
    expect(at({ session_started: 1 })).toBe(1)
    expect(at({})).toBeUndefined()
  })
})

describe('the snippet', () => {
  it('splits the matched runs out of the plain text', () => {
    expect(snippetSegments('the >>>invoice<<< service')).toEqual([
      { match: false, text: 'the ' },
      { match: true, text: 'invoice' },
      { match: false, text: ' service' }
    ])
  })

  it('treats an unpaired marker as text, because a message may contain one', () => {
    // `>>>` is a diff conflict marker and a shell redirect. Highlighting to the
    // end of the line on one would be a bug that only ever shows up on real data.
    expect(snippetSegments('cat a >>> b')).toEqual([{ match: false, text: 'cat a >>> b' }])
  })

  it('trims the JSON the index is built over off each end, and only off the ends', () => {
    // The FTS row is the JSON-encoded message, so a window into it opens and
    // closes mid-structure. `{"a":1}` in the middle is the message's own text.
    expect(plainSnippet('>>>invoices<<< there."}')).toBe('invoices there.')
    expect(plainSnippet('sent {"a":1} along')).toBe('sent {"a":1} along')
  })

  it('collapses the whitespace a fenced block puts in one', () => {
    expect(plainSnippet('one\n\n  two')).toBe('one two')
  })
})
