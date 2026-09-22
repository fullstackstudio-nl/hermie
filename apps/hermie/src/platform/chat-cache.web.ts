/**
 * The chat cache in a browser: IndexedDB, with the same contract the SQLite
 * one answers.
 *
 * IndexedDB rather than `localStorage` because a cached transcript is a JSON
 * blob per bot and `localStorage` is a synchronous 5 MB drawer shared with
 * everything else on the origin — one long chat would evict the preferences
 * sitting next to it. IndexedDB is asynchronous, has a real quota, and stores
 * structured values without a stringify round trip.
 *
 * Deliberately a hand-written wrapper of about eighty lines rather than a
 * dependency: two object stores with a string key each is the whole schema, and
 * the app already carries every byte of its bundle over the network.
 *
 * What is NOT the same as on a phone: a browser may throw the moment the
 * database is opened (private windows, "block all cookies", a storage bucket
 * the user cleared mid-session). `FallbackChatCache` already treats that as a
 * downgrade to memory, so the failure costs a cold paint, never a chat.
 */
import { type CachedBotRow, type CachedTranscriptRow, type ChatCache, FallbackChatCache } from './chat-cache-core'
import { ServiceChatCache } from './service-chat-cache.web'

export {
  type CachedBotRow,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache,
  MemoryChatCache
} from './chat-cache-core'

const DATABASE_NAME = 'hermie-chats'
const DATABASE_VERSION = 1
const TRANSCRIPTS = 'transcripts'
const BOTS = 'bots'

/** Promisify one IDB request. Every call in this file goes through it. */
function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

/**
 * Wait for the TRANSACTION rather than for the last request on it.
 *
 * A write that resolves its own request has not been committed yet; the tab can
 * still be closed between the two. `oncomplete` is the only event that means
 * the bytes are down.
 */
function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })
}

export class IndexedDbChatCache implements ChatCache {
  private opening: Promise<IDBDatabase> | null = null

  private db(): Promise<IDBDatabase> {
    if (!this.opening) {
      this.opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('This browser has no IndexedDB.'))

          return
        }

        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

        request.onupgradeneeded = () => {
          const database = request.result

          if (!database.objectStoreNames.contains(TRANSCRIPTS)) {
            database.createObjectStore(TRANSCRIPTS, { keyPath: 'bot' })
          }

          if (!database.objectStoreNames.contains(BOTS)) {
            database.createObjectStore(BOTS, { keyPath: 'name' })
          }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open.'))
        // A private window answers neither event; without this the first cached
        // read would hang for the life of the tab instead of downgrading.
        request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'))
      }).catch((error: unknown) => {
        // A failed open must not poison every later call with the same rejected
        // promise; the next call gets a fresh attempt.
        this.opening = null

        throw error
      })
    }

    return this.opening
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<[IDBObjectStore, IDBTransaction]> {
    const transaction = (await this.db()).transaction(name, mode)

    return [transaction.objectStore(name), transaction]
  }

  async read(bot: string): Promise<CachedTranscriptRow | null> {
    const [store] = await this.store(TRANSCRIPTS, 'readonly')

    return (await promise<CachedTranscriptRow | undefined>(store.get(bot))) ?? null
  }

  async write(snapshot: CachedTranscriptRow): Promise<void> {
    const [store, transaction] = await this.store(TRANSCRIPTS, 'readwrite')
    store.put(snapshot)

    await settled(transaction)
  }

  async forget(bot: string): Promise<void> {
    const [store, transaction] = await this.store(TRANSCRIPTS, 'readwrite')
    store.delete(bot)

    await settled(transaction)
  }

  async readBots(): Promise<CachedBotRow[]> {
    const [store] = await this.store(BOTS, 'readonly')
    const rows = await promise<CachedBotRow[]>(store.getAll() as IDBRequest<CachedBotRow[]>)

    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The roster is replaced wholesale rather than upserted row by row: a bot the
   * gateway no longer lists has to disappear from the cached list too, or the
   * next cold start paints a bot that is gone.
   */
  async writeBots(rows: CachedBotRow[]): Promise<void> {
    const [store, transaction] = await this.store(BOTS, 'readwrite')
    store.clear()

    for (const row of rows) {
      store.put(row)
    }

    await settled(transaction)
  }

  async clear(): Promise<void> {
    const database = await this.db()
    const transaction = database.transaction([TRANSCRIPTS, BOTS], 'readwrite')
    transaction.objectStore(TRANSCRIPTS).clear()
    transaction.objectStore(BOTS).clear()

    await settled(transaction)
  }
}

/**
 * The app's cache. One instance for the page; it holds one database handle.
 *
 * Two stores, in this order: the browser's own, and then Hermie Web's
 * ([ADR-0024](../../../../docs/adr/0024-hermie-web-is-a-service-layer.md)).
 * IndexedDB is per browser and per device, so it has nothing at all on a first
 * visit, on a new laptop, in a private window or after site data is cleared —
 * which is exactly when a chat used to open on a spinner. The service's copy
 * covers precisely that gap and nothing else; `service-chat-cache.web.ts` says
 * why it is consulted second rather than first.
 *
 * The fallback wrapper goes INSIDE. A browser that refuses IndexedDB should
 * still be able to read the service's copy, and a `FallbackChatCache` wrapped
 * around the pair would downgrade both on the first local failure.
 */
export const chatCache: ChatCache = new ServiceChatCache(new FallbackChatCache(new IndexedDbChatCache()))
