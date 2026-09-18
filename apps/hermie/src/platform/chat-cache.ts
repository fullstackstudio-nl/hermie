/**
 * Offline snapshot of a Bot Chat. The cache is painted before the gateway
 * answers, then reconciled against the live transcript, so the stored shape is
 * deliberately opaque here: the transcript module owns the item format.
 */
export type CachedTranscript = {
  bot: string
  itemsJson: string
  lastRowId: string | null
  lastSeq: number | null
  epoch: string | null
  updatedAt: number
}

export type ChatCache = {
  read(bot: string): Promise<CachedTranscript | null>
  write(snapshot: CachedTranscript): Promise<void>
  forget(bot: string): Promise<void>
  clear(): Promise<void>
}

/**
 * Non-persistent cache. It satisfies the contract without a database, which
 * keeps the app running on platforms where expo-sqlite is not yet verified and
 * makes tests independent of native storage. The SQLite implementation replaces
 * it where it is available.
 */
export class MemoryChatCache implements ChatCache {
  private readonly entries = new Map<string, CachedTranscript>()

  async read(bot: string): Promise<CachedTranscript | null> {
    return this.entries.get(bot) ?? null
  }

  async write(snapshot: CachedTranscript): Promise<void> {
    this.entries.set(snapshot.bot, snapshot)
  }

  async forget(bot: string): Promise<void> {
    this.entries.delete(bot)
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }
}
