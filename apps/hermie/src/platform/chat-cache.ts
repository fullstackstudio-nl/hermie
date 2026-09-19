/**
 * Offline snapshot of the bot roster and of every Bot Chat.
 *
 * The cache exists so a chat paints before the gateway has said a word: the
 * stored items are handed straight to `stateFromCache`, drawn as
 * `hydration: 'cached'`, and then reconciled against the live transcript, which
 * keeps item ids stable and stops the thread from remounting under the user.
 *
 * What the rows hold is deliberately opaque here — `@hermie/transcript` owns
 * the item format and its `format` field, so a shape change there invalidates a
 * snapshot without this module needing to know why.
 */
import * as SQLite from 'expo-sqlite'

export type CachedTranscriptRow = {
  bot: string
  itemsJson: string
  lastRowId: number | null
  lastSeq: number | null
  epoch: string | null
  updatedAt: number
}

export type CachedBotRow = {
  name: string
  json: string
  avatarRev: number
  updatedAt: number
}

export type ChatCache = {
  read(bot: string): Promise<CachedTranscriptRow | null>
  write(snapshot: CachedTranscriptRow): Promise<void>
  forget(bot: string): Promise<void>
  readBots(): Promise<CachedBotRow[]>
  writeBots(rows: CachedBotRow[]): Promise<void>
  clear(): Promise<void>
}

/**
 * Non-persistent cache. It satisfies the contract without a database, which
 * keeps the app running where expo-sqlite is not available and makes tests
 * independent of native storage.
 */
export class MemoryChatCache implements ChatCache {
  private readonly transcripts = new Map<string, CachedTranscriptRow>()
  private bots: CachedBotRow[] = []

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    return this.transcripts.get(bot) ?? null
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    this.transcripts.set(snapshot.bot, snapshot)
  }

  async forget(bot: string): Promise<void> {
    this.transcripts.delete(bot)
  }

  async readBots(): Promise<CachedBotRow[]> {
    return [...this.bots]
  }

  async writeBots(rows: CachedBotRow[]): Promise<void> {
    this.bots = [...rows]
  }

  async clear(): Promise<void> {
    this.transcripts.clear()
    this.bots = []
  }
}

const DATABASE_NAME = 'hermie-chats.db'

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bots (
  name TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  avatar_rev INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  bot TEXT PRIMARY KEY NOT NULL,
  items_json TEXT NOT NULL,
  last_row_id INTEGER,
  last_seq INTEGER,
  epoch TEXT,
  updated_at INTEGER NOT NULL
);
`

interface TranscriptDbRow {
  bot: string
  items_json: string
  last_row_id: number | null
  last_seq: number | null
  epoch: string | null
  updated_at: number
}

interface BotDbRow {
  name: string
  json: string
  avatar_rev: number
  updated_at: number
}

/**
 * The persistent cache.
 *
 * Every method funnels through `db()`, a single-flight open that also creates
 * the schema. Opening lazily rather than in the constructor is what lets the
 * factory below fall back to memory on a platform where the native module links
 * but throws the first time it is actually used.
 */
export class SqliteChatCache implements ChatCache {
  private opening: Promise<SQLite.SQLiteDatabase> | null = null

  private db(): Promise<SQLite.SQLiteDatabase> {
    if (!this.opening) {
      this.opening = SQLite.openDatabaseAsync(DATABASE_NAME)
        .then(async database => {
          await database.execAsync(SCHEMA)

          return database
        })
        .catch(error => {
          // A failed open must not poison every later call with the same
          // rejected promise; the next call gets a fresh attempt.
          this.opening = null

          throw error
        })
    }

    return this.opening
  }

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    const database = await this.db()
    const row = await database.getFirstAsync<TranscriptDbRow>('SELECT * FROM transcripts WHERE bot = ?', bot)

    if (!row) {
      return null
    }

    return {
      bot: row.bot,
      itemsJson: row.items_json,
      lastRowId: row.last_row_id,
      lastSeq: row.last_seq,
      epoch: row.epoch,
      updatedAt: row.updated_at
    }
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    const database = await this.db()

    await database.runAsync(
      `INSERT INTO transcripts (bot, items_json, last_row_id, last_seq, epoch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot) DO UPDATE SET
         items_json = excluded.items_json,
         last_row_id = excluded.last_row_id,
         last_seq = excluded.last_seq,
         epoch = excluded.epoch,
         updated_at = excluded.updated_at`,
      snapshot.bot,
      snapshot.itemsJson,
      snapshot.lastRowId,
      snapshot.lastSeq,
      snapshot.epoch,
      snapshot.updatedAt
    )
  }

  async forget(bot: string): Promise<void> {
    const database = await this.db()

    await database.runAsync('DELETE FROM transcripts WHERE bot = ?', bot)
  }

  async readBots(): Promise<CachedBotRow[]> {
    const database = await this.db()
    const rows = await database.getAllAsync<BotDbRow>('SELECT * FROM bots ORDER BY name')

    return rows.map(row => ({
      name: row.name,
      json: row.json,
      avatarRev: row.avatar_rev,
      updatedAt: row.updated_at
    }))
  }

  /**
   * The roster is replaced wholesale rather than upserted row by row: a bot the
   * gateway no longer lists has to disappear from the cached list too, or the
   * next cold start paints a bot that is gone.
   */
  async writeBots(rows: CachedBotRow[]): Promise<void> {
    const database = await this.db()

    await database.withTransactionAsync(async () => {
      await database.runAsync('DELETE FROM bots')

      for (const row of rows) {
        await database.runAsync(
          'INSERT INTO bots (name, json, avatar_rev, updated_at) VALUES (?, ?, ?, ?)',
          row.name,
          row.json,
          row.avatarRev,
          row.updatedAt
        )
      }
    })
  }

  async clear(): Promise<void> {
    const database = await this.db()

    await database.execAsync('DELETE FROM transcripts; DELETE FROM bots;')
  }
}

/**
 * A cache that starts on SQLite and gives up on it for good the first time the
 * native module throws.
 *
 * A native module that is present is not a native module that works — a full
 * disk, a corrupt database file, a sandbox that refuses the path — and the app
 * is not allowed to lose a chat over a cache. So every call is tried against
 * SQLite once; the first failure downgrades the whole instance to memory and
 * logs one line, and the chat carries on with a cache that simply forgets
 * between launches.
 */
export class FallbackChatCache implements ChatCache {
  private primary: ChatCache | null
  private readonly fallback = new MemoryChatCache()

  constructor(primary: ChatCache = new SqliteChatCache()) {
    this.primary = primary
  }

  /** True once SQLite has thrown and the instance has downgraded. */
  get degraded(): boolean {
    return this.primary === null
  }

  private async run<T>(action: (cache: ChatCache) => Promise<T>): Promise<T> {
    const primary = this.primary

    if (!primary) {
      return action(this.fallback)
    }

    try {
      return await action(primary)
    } catch (error) {
      this.primary = null
      console.warn('[hermie] the chat cache database is unavailable; continuing in memory only.', error)

      return action(this.fallback)
    }
  }

  read(bot: string): Promise<CachedTranscriptRow | null> {
    return this.run(cache => cache.read(bot))
  }

  write(snapshot: CachedTranscriptRow): Promise<void> {
    return this.run(cache => cache.write(snapshot))
  }

  forget(bot: string): Promise<void> {
    return this.run(cache => cache.forget(bot))
  }

  readBots(): Promise<CachedBotRow[]> {
    return this.run(cache => cache.readBots())
  }

  writeBots(rows: CachedBotRow[]): Promise<void> {
    return this.run(cache => cache.writeBots(rows))
  }

  clear(): Promise<void> {
    return this.run(cache => cache.clear())
  }
}

/** The app's cache. One instance for the process; it holds one database handle. */
export const chatCache: ChatCache = new FallbackChatCache()
