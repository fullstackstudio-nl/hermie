import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_INDEX_FILE,
  CACHE_ROW_LIMIT,
  isCapturableAnswer,
  rowsOfMessagesBody,
  sessionIdOfMessagesPath,
  TranscriptCache
} from './cache'

/**
 * The store behind `GET /hermie/cache/<id>`
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * Everything here is about the three things a cache has to get right when
 * nobody is watching it: that what comes out is what went in, that a chat
 * answers to every name it has, and that it never grows without bound.
 */

let dir: string

const rows = (count: number, from = 0): Record<string, unknown>[] =>
  Array.from({ length: count }, (_row, index) => ({
    role: 'assistant',
    row_id: from + index,
    text: `row ${from + index}`
  }))

/** Rows padded to a known size, so a byte cap can be asserted rather than guessed at. */
const fatRows = (count: number, padding = 2000): Record<string, unknown>[] =>
  Array.from({ length: count }, (_row, index) => ({ role: 'assistant', row_id: index, text: 'x'.repeat(padding) }))

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hermie-web-cache-'))
})

const open = (over: { maxBytes?: number; now?: () => number } = {}) =>
  new TranscriptCache({ dir, maxBytes: over.maxBytes ?? 1024 * 1024, ...(over.now ? { now: over.now } : {}) })

describe('the transcript cache', () => {
  it('gives back what it was given, with the shape the rows came off', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: 'stored-1',
      shape: 'rest',
      rows: rows(3),
      updatedAt: 10
    })

    const entry = await cache.get('tip-1')

    expect(entry?.rows).toHaveLength(3)
    expect(entry?.shape).toBe('rest')
    expect(entry?.bot).toBe('researcher')
    expect(entry?.updatedAt).toBe(10)
  })

  it('answers to the session id, the stored id and the bot’s name', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: 'stored-1',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })

    // One canonical Bot Chat per bot (ADR-0007), and the seam in the browser
    // holds the NAME — it has no session id at the moment it has to ask.
    expect((await cache.get('stored-1'))?.sessionId).toBe('tip-1')
    expect((await cache.get('researcher'))?.sessionId).toBe('tip-1')
    expect(await cache.get('someone-else')).toBeNull()
  })

  it('keeps the newest rows and no more than the limit', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: rows(CACHE_ROW_LIMIT + 50),
      updatedAt: 1
    })

    const entry = await cache.get('tip-1')

    expect(entry?.rows).toHaveLength(CACHE_ROW_LIMIT)
    // The TAIL, because that is the end a chat opens at.
    expect(entry?.rows.at(-1)).toMatchObject({ row_id: CACHE_ROW_LIMIT + 49 })
  })

  it('serves an owned entry to its owner and nobody else', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-mine',
      bot: '',
      owner: 'ada@example.invalid',
      storedId: 'stored-mine',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })

    expect(await cache.get('tip-mine', 'ada@example.invalid')).toBeTruthy()
    // A MISS, not an error: the seam's contract is "paint if there is
    // something", and a refusal would also confirm the chat exists.
    expect(await cache.get('tip-mine', 'grace@example.invalid')).toBeNull()
    expect(await cache.get('tip-mine')).toBeNull()
  })

  it('never lets an owned entry answer to the bot’s own name', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-mine',
      // A writer that knows BOTH — which nothing does today, and which is
      // exactly why the rule is in the cache rather than in its callers.
      bot: 'researcher',
      owner: 'ada@example.invalid',
      storedId: 'stored-mine',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })

    // `/hermie/cache/<bot>` means "this bot's SHARED chat": it is what the seam
    // asks when all it holds is a profile name.
    expect(await cache.get('researcher', 'ada@example.invalid')).toBeNull()
    expect(await cache.get('tip-mine', 'ada@example.invalid')).toBeTruthy()
  })

  it('keeps a canonical chat shared however many people read it', async () => {
    const cache = open()
    // The service link resumes the Bot Chat for push and names the bot.
    await cache.put({
      sessionId: 'tip-shared',
      bot: 'researcher',
      owner: '',
      storedId: 'stored-shared',
      shape: 'rpc',
      rows: rows(2),
      updatedAt: 1
    })
    // Then a reader fetches the same transcript over REST, and the tee — which
    // cannot tell the two kinds apart — offers its own name for it.
    await cache.put({
      sessionId: 'tip-shared',
      bot: '',
      owner: 'ada@example.invalid',
      storedId: '',
      shape: 'rest',
      rows: rows(3),
      updatedAt: 2
    })

    expect((await cache.get('tip-shared', 'grace@example.invalid'))?.rows).toHaveLength(3)
    expect((await cache.get('researcher', 'grace@example.invalid'))?.rows).toHaveLength(3)
  })

  it('does not let a shared entry launder a private one', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-mine',
      bot: '',
      owner: 'ada@example.invalid',
      storedId: '',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })
    // A second reader of the SAME private session. The owner is replaced, not
    // widened: the entry describes the bytes that were last written.
    await cache.put({
      sessionId: 'tip-mine',
      bot: '',
      owner: 'grace@example.invalid',
      storedId: '',
      shape: 'rest',
      rows: rows(4),
      updatedAt: 2
    })

    expect(await cache.get('tip-mine', 'ada@example.invalid')).toBeNull()
    expect((await cache.get('tip-mine', 'grace@example.invalid'))?.rows).toHaveLength(4)
  })

  it('carries the owner across a restart', async () => {
    const first = open()
    await first.put({
      sessionId: 'tip-mine',
      bot: '',
      owner: 'ada@example.invalid',
      storedId: '',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })

    const second = open()

    expect(await second.get('tip-mine', 'grace@example.invalid')).toBeNull()
    expect(await second.get('tip-mine', 'ada@example.invalid')).toBeTruthy()
  })

  it('stores nothing for an answer with no rows in it', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: [],
      updatedAt: 1
    })

    // A gateway that answered nothing is not a chat with nothing in it, and
    // writing the second for the first would paint an empty thread over a
    // cached one.
    expect(await cache.get('tip-1')).toBeNull()
    expect(cache.count).toBe(0)
  })

  it('does not let a writer that knows no bot erase the one that did', async () => {
    const cache = open()
    await cache.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: 'stored-1',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })
    // The proxy tee sees a session id and nothing else.
    await cache.put({
      sessionId: 'tip-1',
      bot: '',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: rows(4),
      updatedAt: 2
    })

    const entry = await cache.get('tip-1')

    expect(entry?.rows).toHaveLength(4)
    expect(entry?.bot).toBe('researcher')
    expect((await cache.get('researcher'))?.sessionId).toBe('tip-1')
  })

  it('survives a restart, because the index is on disk beside the entries', async () => {
    const first = open()
    await first.put({
      sessionId: 'tip-1',
      bot: 'researcher',
      owner: '',
      storedId: '',
      shape: 'rpc',
      rows: rows(2),
      updatedAt: 5
    })

    const second = open()

    expect((await second.get('researcher'))?.shape).toBe('rpc')
    expect(JSON.parse(await readFile(path.join(dir, CACHE_INDEX_FILE), 'utf8'))).toMatchObject({ v: 1 })
  })

  it('starts empty rather than refusing to run on an index it cannot read', async () => {
    const broken = open()
    await broken.put({
      sessionId: 'tip-1',
      bot: 'a',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: rows(1),
      updatedAt: 1
    })
    await broken.clear()

    expect(await open().get('tip-1')).toBeNull()
  })
})

describe('eviction', () => {
  it('drops the least recently SERVED chat, not the least recently written', async () => {
    let clock = 100
    // Each of these is a shade over 2 kB, so there is room for two and not three.
    const cache = open({ maxBytes: 5000, now: () => clock })

    await cache.put({
      sessionId: 'a',
      bot: 'a',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })
    clock += 1
    await cache.put({
      sessionId: 'b',
      bot: 'b',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })

    // `a` is the OLDER write and the NEWER read: somebody has it open.
    clock += 1
    expect(await cache.get('a')).not.toBeNull()

    clock += 1
    await cache.put({
      sessionId: 'c',
      bot: 'c',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })

    const kept = (await cache.report()).map(row => row.sessionId).sort()

    expect(kept).toEqual(['a', 'c'])
    expect(await cache.get('b')).toBeNull()
  })

  it('takes the file with the entry', async () => {
    const cache = open({ maxBytes: 4000 })

    await cache.put({
      sessionId: 'a',
      bot: 'a',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })
    await cache.put({
      sessionId: 'b',
      bot: 'b',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })

    // The index plus exactly one entry: an eviction that only forgot would
    // leave the disk growing for ever while the cap looked respected.
    expect((await readdir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(2)
  })

  it('keeps the entry it was just given, even when that one alone is over the cap', async () => {
    const cache = open({ maxBytes: 10 })

    await cache.put({
      sessionId: 'a',
      bot: 'a',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows: fatRows(1),
      updatedAt: 1
    })

    // The alternative is a cache that accepts a write, deletes it, and reports
    // a size of zero for ever.
    expect(await cache.get('a')).not.toBeNull()
  })

  it('stores nothing at all when it is turned off', async () => {
    const off = new TranscriptCache({ dir, maxBytes: 0 })

    expect(off.enabled).toBe(false)
    await off.put({ sessionId: 'a', bot: 'a', owner: '', storedId: '', shape: 'rest', rows: rows(3), updatedAt: 1 })

    expect(await off.get('a')).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })
})

describe('display_metadata.author', () => {
  it('round-trips a sender the gateway attributed, and a row it did not, byte for byte', async () => {
    const cache = open()
    // A real `GET /api/sessions/{id}/messages` body, run through the same
    // reader the proxy tee uses — not a hand-rolled row. `cache.ts` claims
    // rows are stored "exactly as the gateway sent them"; this is that claim
    // turned into a gate for the one field this feature adds.
    const body = {
      messages: [
        {
          role: 'user',
          row_id: 1,
          text: 'ship it',
          display_metadata: { author: { id: 'google:118439', name: 'Robin' } }
        },
        // No author at all — a message from before the stamp existed, from the
        // Hermes dashboard, or from a plain-upstream gateway. Nothing here may
        // add one.
        {
          role: 'user',
          row_id: 2,
          text: 'from before the stamp existed'
        }
      ]
    }
    const rows = rowsOfMessagesBody(body)

    await cache.put({
      sessionId: 'tip-authors',
      bot: 'researcher',
      owner: '',
      storedId: '',
      shape: 'rest',
      rows,
      updatedAt: 1
    })

    const entry = await cache.get('tip-authors')

    // The whole row, not just the field — a cache that altered anything else
    // about an attributed row would be as much a defect as one that dropped
    // the author.
    expect(entry?.rows).toEqual(rows)
    expect(JSON.stringify(entry?.rows)).toBe(JSON.stringify(rows))

    expect(entry?.rows[0]?.display_metadata).toEqual({ author: { id: 'google:118439', name: 'Robin' } })
    // The unattributed row stays unattributed: no `display_metadata` key was
    // invented for it on the way through.
    expect(entry?.rows[1]).not.toHaveProperty('display_metadata')
  })
})

describe('what is worth copying off the proxy', () => {
  it('finds the session id in a transcript read, and only there', () => {
    expect(sessionIdOfMessagesPath('/api/sessions/tip-1/messages')).toBe('tip-1')
    expect(sessionIdOfMessagesPath('/api/sessions/tip%2F1/messages')).toBe('tip/1')
    expect(sessionIdOfMessagesPath('/api/sessions/tip-1/messages/3')).toBe('')
    expect(sessionIdOfMessagesPath('/api/status')).toBe('')
  })

  it('copies only an uncompressed JSON 200', () => {
    const answer = { statusCode: 200, contentType: 'application/json; charset=utf-8', contentEncoding: '' }

    expect(isCapturableAnswer(answer)).toBe(true)
    expect(isCapturableAnswer({ ...answer, contentEncoding: 'identity' })).toBe(true)
    // Inflating on the path of every transcript read, for a copy that is only
    // an optimisation, is not a trade worth making.
    expect(isCapturableAnswer({ ...answer, contentEncoding: 'gzip' })).toBe(false)
    expect(isCapturableAnswer({ ...answer, statusCode: 404 })).toBe(false)
    expect(isCapturableAnswer({ ...answer, contentType: 'text/html' })).toBe(false)
  })

  it('reads the rows under either name the gateway uses', () => {
    expect(rowsOfMessagesBody({ messages: [{ row_id: 1 }] })).toHaveLength(1)
    expect(rowsOfMessagesBody({ rows: [{ row_id: 1 }, { row_id: 2 }] })).toHaveLength(2)
    expect(rowsOfMessagesBody({ detail: 'nope' })).toEqual([])
    expect(rowsOfMessagesBody(null)).toEqual([])
  })
})
