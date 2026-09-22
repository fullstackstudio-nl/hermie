/**
 * The message cache: the reason a chat opened in a browser that has never seen
 * it paints instead of spinning.
 *
 * [ADR-0024](../../../docs/adr/0024-hermie-web-is-a-service-layer.md). The app's
 * own cache is IndexedDB on the web, which is per browser and per device, so a
 * first visit, a new laptop and a cleared site-data drawer all mean the same
 * thing: a spinner, a full history read, and a thread that arrives at once and
 * moves. This service already holds an authenticated link to the gateway for
 * push, and it already sees every `GET /api/sessions/<id>/messages` the browser
 * makes. Both of those are transcript tails going past a process with a disk.
 *
 * ## What is stored, and what is deliberately not understood
 *
 * **Rows, exactly as the gateway sent them.** Nothing here parses a row, and
 * nothing here knows what a transcript ITEM is. Two reasons, and either alone
 * would be enough:
 *
 *  - Hermie Web ships as a self-contained CommonJS `dist/server` with **no
 *    `node_modules`** beside it, so it cannot import `@hermie/transcript` at
 *    runtime any more than `link.ts` can import the shared gateway client.
 *  - The item format is the APP's, and it changes with the app. A server that
 *    understood it would have to be released in step with it; a server that
 *    stores rows is right for every build that can read the gateway at all.
 *
 * The seam in the browser does the conversion, with the same `rowsToItems` it
 * already uses for a live history read — which is also what makes the painted
 * ids line up with the ones the real history hands out a moment later, and
 * therefore what keeps the view still.
 *
 * ## Who an entry belongs to
 *
 * A gateway, not a person. `session.list` and `profiles.list` offer no field
 * that says which user owns a session, so there is nothing to key on, and
 * ADR-0024 writes that down rather than implying a privacy this does not have.
 * By [ADR-0007](../../../docs/adr/0007-canonical-bot-chats-only.md) the
 * canonical Bot Chat is one per bot and shared by everyone who can reach that
 * bot, so a cache of it is already not private to one reader — but the read
 * route still demands the caller's own gateway session, because "already shared
 * among signed-in people" is not "readable by anyone who can reach the port".
 *
 * ## Eviction
 *
 * A byte cap and least-recently-USED order, where "used" means served to a
 * browser rather than written by the daemon. A chat nobody opens is the one to
 * drop, however busy its bot is.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** How many rows one session is worth keeping. The app's own cache stops at the same number. */
export const CACHE_ROW_LIMIT = 200

/** Bumped when a reader could not safely take an older file. */
export const CACHE_VERSION = 1

export const CACHE_INDEX_FILE = 'index.json'

/** Default cap, in megabytes. Enough for a few hundred chats' tails. */
export const DEFAULT_CACHE_MAX_MB = 64

/**
 * Which transport the rows came off.
 *
 * It travels because `rowsToItems` needs it: the REST transcript and
 * `session.history` name the same fields differently, and a tail read as the
 * wrong shape projects to items with no row ids on them — which is exactly the
 * thing that would make the reconcile hand out new ids and move the view.
 */
export type RowShape = 'rest' | 'rpc'

export interface CacheEntry {
  sessionId: string
  /** The profile name, when the writer knew it. The seam reads by this. */
  bot: string
  /** The registry row id, which is a third name the same chat answers to. */
  storedId: string
  shape: RowShape
  rows: Record<string, unknown>[]
  /** Unix seconds this entry was written. */
  updatedAt: number
}

/**
 * The half of the cache a writer needs.
 *
 * The daemon takes this rather than the class so a test can hand it a recorder,
 * and so nothing in the push half can read the cache back — it is a feed, not a
 * store it shares.
 */
export interface TranscriptCacheSink {
  readonly enabled: boolean
  put(entry: CacheEntry): Promise<void>
}

interface IndexRow {
  sessionId: string
  bot: string
  storedId: string
  shape: RowShape
  file: string
  rows: number
  bytes: number
  updatedAt: number
  /** Unix seconds this entry was last SERVED. The LRU key. */
  readAt: number
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A file name that is a function of the session id and contains nothing of it. */
function fileFor(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`
}

export interface TranscriptCacheOptions {
  dir: string
  /** `0` turns the cache off entirely, which is what `--cache-max-mb 0` means. */
  maxBytes: number
  now?: () => number
  log?: (line: string) => void
}

export class TranscriptCache {
  /** session id → its index row. The one authority on what is on disk. */
  private readonly rows = new Map<string, IndexRow>()
  /** Every name a session answers to → its session id. */
  private readonly aliases = new Map<string, string>()
  private bytes = 0
  private loaded = false
  /** Serialises index writes, so two puts cannot interleave a read-modify-write. */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: TranscriptCacheOptions) {}

  get enabled(): boolean {
    return this.options.maxBytes > 0
  }

  get size(): number {
    return this.bytes
  }

  get count(): number {
    return this.rows.size
  }

  private get now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private get indexPath(): string {
    return path.join(this.options.dir, CACHE_INDEX_FILE)
  }

  /**
   * Read the index, or start empty.
   *
   * Like the push state, every failure is the same answer: an empty cache. The
   * cost is a cold paint on the next open, and the alternative is a service
   * that will not serve the app over a file it could have ignored.
   */
  async load(): Promise<void> {
    if (this.loaded || !this.enabled) {
      this.loaded = true

      return
    }

    this.loaded = true

    let parsed: Record<string, unknown>

    try {
      parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as Record<string, unknown>
    } catch {
      return
    }

    if (num(parsed.v) !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return
    }

    for (const raw of parsed.entries as Record<string, unknown>[]) {
      const sessionId = str(raw?.sessionId)

      if (!sessionId) {
        continue
      }

      this.remember({
        sessionId,
        bot: str(raw.bot),
        storedId: str(raw.storedId),
        shape: raw.shape === 'rpc' ? 'rpc' : 'rest',
        file: str(raw.file) || fileFor(sessionId),
        rows: num(raw.rows),
        bytes: num(raw.bytes),
        updatedAt: num(raw.updatedAt),
        readAt: num(raw.readAt)
      })
    }
  }

  private remember(row: IndexRow): void {
    const held = this.rows.get(row.sessionId)

    if (held) {
      this.bytes -= held.bytes
    }

    this.rows.set(row.sessionId, row)
    this.bytes += row.bytes

    for (const alias of [row.sessionId, row.storedId, row.bot]) {
      if (alias) {
        this.aliases.set(alias, row.sessionId)
      }
    }
  }

  /**
   * Store one session's tail.
   *
   * An empty row list is a no-op rather than an empty entry: a gateway that
   * answered nothing is not the same as a chat with nothing in it, and writing
   * the second for the first would paint an empty thread over a cached one.
   */
  async put(entry: CacheEntry): Promise<void> {
    if (!this.enabled || !entry.sessionId || !entry.rows.length) {
      return
    }

    await this.load()

    this.tail = this.tail.then(() => this.write(entry)).catch(() => undefined)

    return this.tail
  }

  private async write(entry: CacheEntry): Promise<void> {
    const file = fileFor(entry.sessionId)
    const rows = entry.rows.slice(-CACHE_ROW_LIMIT)
    const payload = `${JSON.stringify({
      v: CACHE_VERSION,
      sessionId: entry.sessionId,
      bot: entry.bot,
      storedId: entry.storedId,
      shape: entry.shape,
      updatedAt: entry.updatedAt || this.now,
      rows
    })}\n`

    try {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 })

      const target = path.join(this.options.dir, file)
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      this.options.log?.(`cache: could not write ${entry.sessionId} — ${String(error)}`)

      return
    }

    const held = this.rows.get(entry.sessionId)

    this.remember({
      sessionId: entry.sessionId,
      // A writer that did not know the bot must not ERASE one an earlier writer
      // did: the proxy tee sees a session id and nothing else, and the seam
      // reads by bot name.
      bot: entry.bot || held?.bot || '',
      storedId: entry.storedId || held?.storedId || '',
      shape: entry.shape,
      file,
      rows: rows.length,
      bytes: Buffer.byteLength(payload),
      updatedAt: entry.updatedAt || this.now,
      // A brand-new entry counts as used now, so a cache that is already full
      // does not evict the thing it has just been told about.
      readAt: held?.readAt ?? this.now
    })

    await this.evict()
    await this.saveIndex()
  }

  /** Serve one session's tail by any of its names. */
  async get(key: string): Promise<(CacheEntry & { rows: Record<string, unknown>[] }) | null> {
    if (!this.enabled || !key) {
      return null
    }

    await this.load()

    const sessionId = this.aliases.get(key)
    const row = sessionId ? this.rows.get(sessionId) : undefined

    if (!row) {
      return null
    }

    let parsed: Record<string, unknown>

    try {
      parsed = JSON.parse(await readFile(path.join(this.options.dir, row.file), 'utf8')) as Record<string, unknown>
    } catch {
      // The index knows about a file that is gone — a half-finished eviction, a
      // directory somebody cleaned by hand. Forget it rather than keep
      // answering for it.
      this.forget(row)
      void this.saveIndex().catch(() => undefined)

      return null
    }

    row.readAt = this.now
    void this.saveIndex().catch(() => undefined)

    return {
      sessionId: row.sessionId,
      bot: row.bot,
      storedId: row.storedId,
      shape: row.shape,
      updatedAt: num(parsed.updatedAt),
      rows: Array.isArray(parsed.rows) ? (parsed.rows as Record<string, unknown>[]) : []
    }
  }

  private forget(row: IndexRow): void {
    this.rows.delete(row.sessionId)
    this.bytes -= row.bytes

    for (const [alias, sessionId] of this.aliases) {
      if (sessionId === row.sessionId) {
        this.aliases.delete(alias)
      }
    }
  }

  /**
   * Drop least-recently-served entries until the cap is met.
   *
   * Never down to nothing: the entry that was just written stays even when it
   * alone is over the cap, because the alternative is a cache that accepts a
   * write, deletes it, and reports a size of zero for ever.
   */
  private async evict(): Promise<void> {
    if (this.bytes <= this.options.maxBytes) {
      return
    }

    const order = [...this.rows.values()].sort((a, b) => a.readAt - b.readAt || a.updatedAt - b.updatedAt)

    for (const row of order) {
      if (this.bytes <= this.options.maxBytes || this.rows.size <= 1) {
        return
      }

      this.forget(row)
      await rm(path.join(this.options.dir, row.file), { force: true }).catch(() => undefined)
      this.options.log?.(`cache: evicted ${row.sessionId} (${row.bytes} bytes)`)
    }
  }

  private async saveIndex(): Promise<void> {
    const payload = `${JSON.stringify({ v: CACHE_VERSION, entries: [...this.rows.values()] }, null, 2)}\n`

    try {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 })

      const temporary = `${this.indexPath}.${process.pid}.tmp`
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.indexPath)
    } catch {
      // An index that cannot be written costs the LRU order across a restart,
      // which the next few reads rebuild. It is not worth failing a request for.
    }
  }

  /**
   * Delete everything, including files the index never knew about.
   *
   * Used by the tests, and by a future `--cache-max-mb 0` restart that should
   * not leave the previous run's transcripts on disk.
   */
  async clear(): Promise<void> {
    this.rows.clear()
    this.aliases.clear()
    this.bytes = 0

    const names = await readdir(this.options.dir).catch(() => [] as string[])

    for (const name of names) {
      if (name.endsWith('.json')) {
        await rm(path.join(this.options.dir, name), { force: true }).catch(() => undefined)
      }
    }
  }

  /** What is on disk right now, newest first. For the tests and for a log line. */
  async report(): Promise<{ sessionId: string; bot: string; bytes: number }[]> {
    await this.load()

    return [...this.rows.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(row => ({ sessionId: row.sessionId, bot: row.bot, bytes: row.bytes }))
  }
}

const MESSAGES_PATH = /^\/api\/sessions\/([^/]+)\/messages$/

/**
 * The session id in a REST transcript path, or `''` for any other path.
 *
 * This is the one proxied route worth watching: it is what the app fetches to
 * paint a long chat, so the bytes going past are exactly the tail this cache
 * wants, already read and already authorised by the gateway.
 */
export function sessionIdOfMessagesPath(pathname: string): string {
  const match = MESSAGES_PATH.exec(pathname)

  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

/** At most this much of a proxied body is buffered before the copy is abandoned. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/**
 * Should this answer be copied into the cache?
 *
 * Three conditions, and all three are about not having to UNDERSTAND the body:
 * it has to be a 200, it has to be JSON, and it has to be unencoded. A gzipped
 * answer would need inflating, which is work on the path of every transcript
 * read for a copy that is only an optimisation — and the gateway and Hermie Web
 * are on the same host, where nothing negotiates compression in the first
 * place.
 */
export function isCapturableAnswer(headers: {
  statusCode?: number | undefined
  contentType?: string | undefined
  contentEncoding?: string | undefined
}): boolean {
  const encoding = (headers.contentEncoding ?? '').trim().toLowerCase()

  return (
    headers.statusCode === 200 &&
    (headers.contentType ?? '').toLowerCase().includes('application/json') &&
    (encoding === '' || encoding === 'identity')
  )
}

/** The rows in a REST transcript answer, under either of the two names it uses. */
export function rowsOfMessagesBody(body: unknown): Record<string, unknown>[] {
  const bag = (body ?? {}) as { messages?: unknown; rows?: unknown }
  const rows = bag.messages ?? bag.rows

  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/** Where the cache lives inside the state directory. */
export function cacheDir(stateDir: string): string {
  return path.join(stateDir, 'cache')
}

/** `stat`, or `null`. Exported so a test can assert a file really went away. */
export async function fileExists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false
  )
}
