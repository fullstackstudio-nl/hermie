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
 * ([ADR-0024](../../../docs/adr/0024-hermie-web-is-a-service-layer.md)).
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

  it('stores nothing for an answer with no rows in it', async () => {
    const cache = open()
    await cache.put({ sessionId: 'tip-1', bot: 'researcher', storedId: '', shape: 'rest', rows: [], updatedAt: 1 })

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
      storedId: 'stored-1',
      shape: 'rest',
      rows: rows(2),
      updatedAt: 1
    })
    // The proxy tee sees a session id and nothing else.
    await cache.put({ sessionId: 'tip-1', bot: '', storedId: '', shape: 'rest', rows: rows(4), updatedAt: 2 })

    const entry = await cache.get('tip-1')

    expect(entry?.rows).toHaveLength(4)
    expect(entry?.bot).toBe('researcher')
    expect((await cache.get('researcher'))?.sessionId).toBe('tip-1')
  })

  it('survives a restart, because the index is on disk beside the entries', async () => {
    const first = open()
    await first.put({ sessionId: 'tip-1', bot: 'researcher', storedId: '', shape: 'rpc', rows: rows(2), updatedAt: 5 })

    const second = open()

    expect((await second.get('researcher'))?.shape).toBe('rpc')
    expect(JSON.parse(await readFile(path.join(dir, CACHE_INDEX_FILE), 'utf8'))).toMatchObject({ v: 1 })
  })

  it('starts empty rather than refusing to run on an index it cannot read', async () => {
    const broken = open()
    await broken.put({ sessionId: 'tip-1', bot: 'a', storedId: '', shape: 'rest', rows: rows(1), updatedAt: 1 })
    await broken.clear()

    expect(await open().get('tip-1')).toBeNull()
  })
})

describe('eviction', () => {
  it('drops the least recently SERVED chat, not the least recently written', async () => {
    let clock = 100
    // Each of these is a shade over 2 kB, so there is room for two and not three.
    const cache = open({ maxBytes: 5000, now: () => clock })

    await cache.put({ sessionId: 'a', bot: 'a', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })
    clock += 1
    await cache.put({ sessionId: 'b', bot: 'b', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })

    // `a` is the OLDER write and the NEWER read: somebody has it open.
    clock += 1
    expect(await cache.get('a')).not.toBeNull()

    clock += 1
    await cache.put({ sessionId: 'c', bot: 'c', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })

    const kept = (await cache.report()).map(row => row.sessionId).sort()

    expect(kept).toEqual(['a', 'c'])
    expect(await cache.get('b')).toBeNull()
  })

  it('takes the file with the entry', async () => {
    const cache = open({ maxBytes: 4000 })

    await cache.put({ sessionId: 'a', bot: 'a', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })
    await cache.put({ sessionId: 'b', bot: 'b', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })

    // The index plus exactly one entry: an eviction that only forgot would
    // leave the disk growing for ever while the cap looked respected.
    expect((await readdir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(2)
  })

  it('keeps the entry it was just given, even when that one alone is over the cap', async () => {
    const cache = open({ maxBytes: 10 })

    await cache.put({ sessionId: 'a', bot: 'a', storedId: '', shape: 'rest', rows: fatRows(1), updatedAt: 1 })

    // The alternative is a cache that accepts a write, deletes it, and reports
    // a size of zero for ever.
    expect(await cache.get('a')).not.toBeNull()
  })

  it('stores nothing at all when it is turned off', async () => {
    const off = new TranscriptCache({ dir, maxBytes: 0 })

    expect(off.enabled).toBe(false)
    await off.put({ sessionId: 'a', bot: 'a', storedId: '', shape: 'rest', rows: rows(3), updatedAt: 1 })

    expect(await off.get('a')).toBeNull()
    expect(await readdir(dir)).toEqual([])
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
