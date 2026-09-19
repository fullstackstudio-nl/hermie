/**
 * Everything the bot roster needs from the gateway.
 *
 * The store next door holds the state; this holds the round trips, so the store
 * stays a pure reducer and this stays drivable from a test with a hand-written
 * `ChatGateway`.
 *
 * The one piece of real logic here is canonical-chat resolution, and it is the
 * piece most worth reading: a bot has exactly ONE forever-chat, the session on
 * its profile titled exactly `Bot Chat`, and every way of getting that wrong
 * ends with the bot apparently losing its memory.
 */
import type { ProfileRow, SessionActiveItem, SessionListRow } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'
import type { CachedBotRow, ChatCache } from '../../platform/chat-cache'
import { type Bot, type BotCanonicalSession, botFromProfileRow, type BotsState } from '../../store/bots'

/** The canonical Bot Chat title. `(profile, title)` is the bot's chat identity. */
export const CANONICAL_CHAT_TITLE = 'Bot Chat'

/** Upper bound on the per-profile `session.list` scan, matching the desktop's. */
export const PROFILE_SESSION_LIST_LIMIT = 200

/** Terminal width the gateway renders transcripts at; the desktop uses the same. */
export const SESSION_COLUMNS = 96

/** How often the roster re-reads running state while the list is on screen. */
export const ACTIVE_LIST_POLL_MS = 10_000

/**
 * `LiveSessionStatus` values that mean the bot is doing something. `waiting` is
 * in: a bot parked on an approval is working, and showing it as idle is how a
 * question goes unanswered for an hour.
 */
const BUSY_SESSION_STATUS: ReadonlySet<string> = new Set(['starting', 'waiting', 'working', 'streaming', 'resuming'])

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

export interface BotsControllerOptions {
  gateway: ChatGateway
  store: StoreApi<BotsState>
  cache?: ChatCache | null
  now?: () => number
}

export class BotsController {
  private readonly gateway: ChatGateway
  private readonly store: StoreApi<BotsState>
  private readonly cache: ChatCache | null
  private readonly now: () => number

  /** One canonical resolution per bot at a time; a double tap must not mint two chats. */
  private readonly resolutions = new Map<string, Promise<BotCanonicalSession>>()
  private refreshInFlight: Promise<Bot[]> | null = null
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private watchers = 0

  constructor(options: BotsControllerOptions) {
    this.gateway = options.gateway
    this.store = options.store
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => Date.now())
  }

  /** Paint the roster from disk. Safe to call before the socket is up. */
  async paintFromCache(): Promise<void> {
    if (!this.cache || this.store.getState().bots.length) {
      return
    }

    let rows: CachedBotRow[] = []

    try {
      rows = await this.cache.readBots()
    } catch {
      return
    }

    const bots: Bot[] = []

    for (const row of rows) {
      try {
        bots.push(JSON.parse(row.json) as Bot)
      } catch {
        // One unreadable row does not invalidate the rest of the list.
      }
    }

    if (bots.length && !this.store.getState().bots.length) {
      this.store.getState().setBots(bots, { fromCache: true })
    }
  }

  /**
   * Re-read the roster. Concurrent callers (pull to refresh landing on top of a
   * `sessions.changed` sweep) share one round trip.
   */
  refresh(): Promise<Bot[]> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const run = this.load().finally(() => {
      this.refreshInFlight = null
    })

    this.refreshInFlight = run

    return run
  }

  private async load(): Promise<Bot[]> {
    const state = this.store.getState()
    state.setLoading(true)

    try {
      const result = await this.gateway.request('profiles.list', { include_sessions: true })
      const rows: ProfileRow[] = Array.isArray(result?.profiles) ? result.profiles : []
      // The name is this bot's identity everywhere — the store key, the chat
      // key, the `profile` every RPC carries. A row without one is not a bot
      // this app can address, and a blank entry in the roster is worse than a
      // missing one.
      const bots = rows.map(botFromProfileRow).filter(bot => Boolean(bot.name))

      this.store.getState().setBots(bots)
      void this.persist(bots)
      void this.loadAvatars(bots)

      return bots
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setLoading(false)
    }
  }

  private async persist(bots: Bot[]): Promise<void> {
    if (!this.cache) {
      return
    }

    const updatedAt = this.now()

    try {
      await this.cache.writeBots(
        bots.map(bot => ({
          name: bot.name,
          json: JSON.stringify(bot),
          avatarRev: bot.uiMetaRevision,
          updatedAt
        }))
      )
    } catch {
      // The roster is a convenience on disk; losing it costs one round trip.
    }
  }

  /**
   * Fetch the avatars this roster has not fetched yet.
   *
   * Keyed on `name + ui_meta_revision`: the gateway bumps that revision when the
   * asset changes, so a hit is valid forever and a miss is never retried on
   * every paint.
   */
  async loadAvatars(bots: readonly Bot[]): Promise<void> {
    const state = this.store.getState()
    const pending = bots.filter(bot => bot.hasAvatar && !state.avatarsFetched[`${bot.name}:${bot.uiMetaRevision}`])

    await Promise.all(
      pending.map(async bot => {
        try {
          const asset = await this.gateway.request('profiles.get_asset', { name: bot.name, asset: 'avatar' })

          this.store.getState().setAvatar(bot.name, bot.uiMetaRevision, asset?.found ? (asset.data ?? null) : null)
        } catch {
          // An avatar is decoration. A failed fetch is not recorded, so the
          // next roster refresh tries again.
        }
      })
    )
  }

  /**
   * Refresh running state for every bot.
   *
   * `session.active_list` answers for one profile's backend at a time, so this
   * is one call per bot. A bot whose call fails is reported as not running
   * rather than as an error: a spinner that will not go away is worse than a
   * missing one.
   */
  async refreshRunning(): Promise<void> {
    const bots = this.store.getState().bots
    const running: string[] = []

    await Promise.all(
      bots.map(async bot => {
        try {
          const result = await this.gateway.request('session.active_list', { profile: bot.name })
          const sessions: SessionActiveItem[] = result?.sessions ?? []

          if (sessions.some(session => BUSY_SESSION_STATUS.has(session.status))) {
            running.push(bot.name)
          }
        } catch {
          // Not running, as far as this poll is concerned.
        }
      })
    )

    this.store.getState().setRunning(running)
  }

  /**
   * Start polling running state; the returned function stops it. Reference
   * counted, so two mounted lists share one interval.
   */
  watchRunning(): () => void {
    this.watchers += 1

    if (this.watchers === 1) {
      void this.refreshRunning()
      this.pollTimer = setInterval(() => void this.refreshRunning(), ACTIVE_LIST_POLL_MS)
    }

    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.watchers -= 1

      if (this.watchers === 0 && this.pollTimer !== undefined) {
        clearInterval(this.pollTimer)
        this.pollTimer = undefined
      }
    }
  }

  /**
   * The bot's forever-chat, resolved the way the desktop resolves it.
   *
   * Three steps, in this order and no other:
   *
   * 1. The roster's own `canonical_session`, which the gateway resolved by
   *    title server-side. No round trip.
   * 2. `session.list {title:'Bot Chat', include_hidden:true, profile}` — an
   *    indexed exact-title lookup, not a recency window, because a busy profile
   *    can push the forever-chat out of any window. Canonical chats are always
   *    hidden, so `include_hidden` is not optional.
   * 3. Only then `session.create`, and only after step 2 has run again: a
   *    backend that was still warming up can answer step 2 with an empty list
   *    rather than an error, and minting on that answer forks the chat.
   *
   * A failed lookup throws. It must never read as "this bot has no chat".
   */
  resolveCanonical(bot: Bot): Promise<BotCanonicalSession> {
    const existing = this.resolutions.get(bot.name)

    if (existing) {
      return existing
    }

    const run = this.runResolution(bot).finally(() => {
      this.resolutions.delete(bot.name)
    })

    this.resolutions.set(bot.name, run)

    return run
  }

  private async runResolution(bot: Bot): Promise<BotCanonicalSession> {
    if (bot.canonical?.id) {
      return bot.canonical
    }

    const found = await this.lookupCanonical(bot)

    if (found) {
      return found
    }

    // Re-run the lookup before minting. Between the first lookup and here the
    // bot may have answered a teammate's DM, which creates the chat server-side.
    const second = await this.lookupCanonical(bot)

    if (second) {
      return second
    }

    const created = await this.gateway.request('session.create', {
      profile: bot.name,
      title: CANONICAL_CHAT_TITLE,
      hidden: true,
      source: 'hermie',
      cols: SESSION_COLUMNS,
      // The chat follows the profile's current model, never a pin stored on an
      // old row; without this a profile switch leaves DMs on a dead provider.
      follow_profile_config: true
    })

    const storedId = created?.stored_session_id || created?.session_id || ''

    if (!storedId) {
      throw new Error(`The gateway created a chat for ${bot.name} without returning its id.`)
    }

    return { id: storedId, resolvedId: storedId, preview: '', lastActive: 0, messageCount: 0 }
  }

  private async lookupCanonical(bot: Bot): Promise<BotCanonicalSession | null> {
    let rows: SessionListRow[]

    try {
      const result = await this.gateway.request('session.list', {
        profile: bot.name,
        title: CANONICAL_CHAT_TITLE,
        limit: PROFILE_SESSION_LIST_LIMIT,
        include_hidden: true
      })

      rows = result?.sessions ?? []
    } catch (error) {
      // FAIL CLOSED. A lookup that errored is not a bot without a chat, and
      // treating it as one is the one remaining way to fork a forever-chat.
      throw new Error(`Could not check ${bot.name}'s chat registry (${messageOf(error)}) — not starting a new chat.`)
    }

    const match = rows.find(row => String(row.title ?? '').trim() === CANONICAL_CHAT_TITLE) ?? rows[0]

    if (!match?.id) {
      return null
    }

    return {
      id: match.id,
      resolvedId: match.resolved_id || match.id,
      preview: typeof match.preview === 'string' ? match.preview : '',
      lastActive: 0,
      messageCount: typeof match.message_count === 'number' ? match.message_count : 0
    }
  }

  /** Stop every timer this controller owns. */
  dispose(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }

    this.watchers = 0
    this.resolutions.clear()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
