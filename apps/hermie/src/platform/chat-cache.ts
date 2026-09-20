/**
 * Offline snapshot of the bot roster and of every Bot Chat, on SQLite.
 *
 * The cache exists so a chat paints before the gateway has said a word: the
 * stored items are handed straight to `stateFromCache`, drawn as
 * `hydration: 'cached'`, and then reconciled against the live transcript, which
 * keeps item ids stable and stops the thread from remounting under the user.
 *
 * The contract, the memory cache and the downgrade wrapper live in
 * `chat-cache-core.ts`; this file is the platform half and the web seam
 * (`chat-cache.web.ts`) replaces exactly it.
 */
import * as SQLite from 'expo-sqlite'

import { type CachedBotRow, type CachedTranscriptRow, type ChatCache, FallbackChatCache } from './chat-cache-core'

export {
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache,
  MemoryChatCache
} from './chat-cache-core'

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

/** The app's cache. One instance for the process; it holds one database handle. */
export const chatCache: ChatCache = new FallbackChatCache(new SqliteChatCache())
