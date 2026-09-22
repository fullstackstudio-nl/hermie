/**
 * The bot roster.
 *
 * A bot is a Hermes profile. Everything the list shows is derived rather than
 * stored twice: `running` comes from `session.active_list` — whose rows the
 * controller has to attribute to a bot by session id, because that call answers
 * for the whole gateway process and its rows carry no profile — unread from the
 * canonical chat's `last_active` against a per-bot watermark, and "needs input"
 * from the open requests the chat store is already holding. The roster itself
 * is cached so the list paints on launch instead of after a round trip.
 */
import type { ProfileRow } from '@hermes/shared/gateway-contract'
import { create } from 'zustand'

import type { GatewayNamespace } from '../gateway/namespace'
import { keyValueStore } from '../platform/key-value-store'

export interface BotCanonicalSession {
  /** The durable registry id. Resume on this, persist this, never the runtime id. */
  id: string
  /** The compression-lineage tip. REST transcript rows are read under this one. */
  resolvedId: string
  preview: string
  lastActive: number
  messageCount: number
}

export interface Bot {
  name: string
  displayName: string
  description: string
  model: string
  provider: string
  isDefault: boolean
  hasAvatar: boolean
  canonical?: BotCanonicalSession
  /**
   * Highest of the profile's `ui_meta_revisions`. Avatars are cached against
   * `name + revision`, so a changed avatar invalidates itself.
   */
  uiMetaRevision: number
}

/**
 * The read watermarks, per gateway.
 *
 * Namespaced because it is keyed by BOT NAME, and bot names are a gateway's
 * own: two gateways can both have a `researcher`, and one list's watermark
 * silently marking the other's chat as read is a message somebody never sees.
 */
export const BOT_LAST_SEEN_KEY = 'hermie.bots.last_seen'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Project one `profiles.list` row onto the roster model. */
export function botFromProfileRow(row: ProfileRow): Bot {
  const canonical = row.canonical_session
  const revisions = Object.values(row.ui_meta_revisions ?? {}).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )

  const name = str(row.name)

  return {
    name,
    displayName: str(row.display_name) || name,
    description: str(row.description),
    model: str(row.model),
    provider: str(row.provider),
    isDefault: row.is_default === true,
    hasAvatar: row.has_avatar === true,
    ...(canonical?.id
      ? {
          canonical: {
            id: canonical.id,
            resolvedId: canonical.resolved_id || canonical.id,
            preview: str(canonical.preview),
            lastActive: num(canonical.last_active),
            messageCount: num(canonical.message_count)
          }
        }
      : {}),
    uiMetaRevision: revisions.length ? Math.max(...revisions) : 0
  }
}

export interface BotsState {
  bots: Bot[]
  byName: Record<string, Bot>
  /** name → data URL. Avatars are small and the gateway ships them base64 already. */
  avatars: Record<string, string>
  /** `name + ':' + revision` for every avatar fetch already attempted, hit or miss. */
  avatarsFetched: Record<string, true>
  /** Bots the last `session.active_list` poll could place a busy session on. */
  running: Record<string, true>
  /** name → the `last_active` the user has already looked at. */
  lastSeen: Record<string, number>
  /**
   * Canonical chats this app switched a bot onto, until the roster catches up.
   *
   * `setBots` overwrites every bot wholesale from `profiles.list`, and that call
   * resolves the canonical chat by TITLE server-side. Between `/new` renaming the
   * old conversation and the gateway persisting the new one there is a window in
   * which a poll — very possibly one that left before the switch — answers with
   * the OLD id, or with no canonical at all because the new session has no
   * database row yet. Either one would silently put the chat back on the
   * conversation the owner just put away.
   *
   * So a switch pins the id it switched to. While a pin stands, a roster row
   * naming anything else is ignored for that bot; the pin clears the moment the
   * roster agrees, which is the gateway confirming the switch landed.
   */
  canonicalPins: Record<string, BotCanonicalSession>
  loading: boolean
  error: string | null
  /** `Date.now()` of the last successful roster read; null while only the cache is painted. */
  refreshedAt: number | null

  setBots: (bots: Bot[], options?: { fromCache?: boolean }) => void
  /** Point a bot at a different canonical chat and hold it there — see `canonicalPins`. */
  setCanonical: (name: string, canonical: BotCanonicalSession) => void
  setAvatar: (name: string, revision: number, dataUrl: string | null) => void
  setRunning: (names: readonly string[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  /** The gateway these watermarks belong to; null before the first read. */
  namespace: GatewayNamespace | null
  hydrateLastSeen: (ns: GatewayNamespace) => Promise<void>
  markSeen: (name: string, lastActive?: number) => void
  reset: () => void
}

const INITIAL = {
  namespace: null as GatewayNamespace | null,
  bots: [] as Bot[],
  byName: {} as Record<string, Bot>,
  avatars: {} as Record<string, string>,
  avatarsFetched: {} as Record<string, true>,
  running: {} as Record<string, true>,
  lastSeen: {} as Record<string, number>,
  canonicalPins: {} as Record<string, BotCanonicalSession>,
  loading: false,
  error: null as string | null,
  refreshedAt: null as number | null
}

let lastSeenQueue: Promise<void> = Promise.resolve()

function persistLastSeen(ns: GatewayNamespace, lastSeen: Record<string, number>): void {
  lastSeenQueue = lastSeenQueue
    .then(() => keyValueStore.setJson(ns.key(BOT_LAST_SEEN_KEY), lastSeen))
    .catch(() => {
      // A lost watermark shows one chat as unread again; not worth an error.
    })
}

export const useBotsStore = create<BotsState>((set, get) => ({
  ...INITIAL,

  setBots(bots, options = {}) {
    const pins = get().canonicalPins
    const keptPins: Record<string, BotCanonicalSession> = {}
    const byName: Record<string, Bot> = {}
    const placed: Bot[] = []

    for (const row of bots) {
      const pinned = pins[row.name]
      // A pin whose id the roster now reports has done its job: the gateway has
      // resolved the canonical title to the chat we switched to, so the answer
      // and the pin say the same thing and the pin is dropped.
      const stale = pinned !== undefined && row.canonical?.id !== pinned.id
      const bot = stale && pinned ? { ...row, canonical: pinned } : row

      if (stale && pinned) {
        keptPins[row.name] = pinned
      }

      byName[bot.name] = bot
      placed.push(bot)
    }

    // A pin whose bot is missing from this answer is kept: the bot did not stop
    // existing, this list simply did not mention it.
    for (const [name, pinned] of Object.entries(pins)) {
      if (!(name in byName)) {
        keptPins[name] = pinned
      }
    }

    set({
      bots: placed,
      byName,
      canonicalPins: keptPins,
      ...(options.fromCache ? {} : { refreshedAt: Date.now(), error: null })
    })
  },

  setCanonical(name, canonical) {
    const current = get().byName[name]

    if (!current) {
      return
    }

    const bot: Bot = { ...current, canonical }

    set(state => ({
      bots: state.bots.map(entry => (entry.name === name ? bot : entry)),
      byName: { ...state.byName, [name]: bot },
      canonicalPins: { ...state.canonicalPins, [name]: canonical }
    }))
  },

  setAvatar(name, revision, dataUrl) {
    set(state => ({
      avatarsFetched: { ...state.avatarsFetched, [`${name}:${revision}`]: true },
      ...(dataUrl ? { avatars: { ...state.avatars, [name]: dataUrl } } : {})
    }))
  },

  setRunning(names) {
    const running: Record<string, true> = {}

    for (const name of names) {
      running[name] = true
    }

    set({ running })
  },

  setLoading(loading) {
    set({ loading })
  },

  setError(error) {
    set({ error })
  },

  async hydrateLastSeen(ns) {
    const stored = await keyValueStore.getJson<Record<string, number>>(ns.key(BOT_LAST_SEEN_KEY))
    const lastSeen: Record<string, number> = {}

    for (const [name, value] of Object.entries(stored ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        lastSeen[name] = value
      }
    }

    set({ namespace: ns, lastSeen })
  },

  markSeen(name, lastActive) {
    const bot = get().byName[name]
    const at = lastActive ?? bot?.canonical?.lastActive ?? Math.floor(Date.now() / 1000)
    const current = get().lastSeen[name] ?? 0

    if (at <= current) {
      return
    }

    const lastSeen = { ...get().lastSeen, [name]: at }
    const ns = get().namespace

    set({ lastSeen })

    // Nothing is written before the gateway is known. A watermark under a key
    // nobody owns is one the next launch cannot find anyway.
    if (ns) {
      persistLastSeen(ns, lastSeen)
    }
  },

  reset() {
    // The namespace survives, and it is the one field that has to. `reset` runs
    // when a connection goes — a sign-out, a reconnect — and the gateway those
    // watermarks belong to has not changed; clearing it would leave `markSeen`
    // with nowhere to write until something re-hydrated the store, which on a
    // sign-in to the same gateway nothing does.
    set({ ...INITIAL, namespace: get().namespace })
  }
}))

/**
 * Unread is "the canonical chat moved since the user last looked at it". It is
 * deliberately a timestamp comparison rather than a counter: the gateway is the
 * only thing that knows how much happened, and it only reports `last_active`.
 */
export function isUnread(state: Pick<BotsState, 'byName' | 'lastSeen'>, name: string): boolean {
  const lastActive = state.byName[name]?.canonical?.lastActive ?? 0

  return lastActive > 0 && lastActive > (state.lastSeen[name] ?? 0)
}

/**
 * What a bot is CALLED, from the handle the rest of the app passes around.
 *
 * A name is the gateway's identifier (`researcher`) and a display name is the
 * label a person reads (`Researcher`); the two are routinely different in case
 * alone, which is exactly the difference nobody notices until it is shown
 * somewhere prominent. Selecting the resolved string rather than the whole map
 * keeps a caller from re-rendering when an unrelated bot's presence moves.
 */
export function useBotDisplayName(name: string | undefined): string | undefined {
  return useBotsStore(state => (name === undefined ? undefined : (state.byName[name]?.displayName ?? name)))
}

/** The avatar cache key; exported so the loader and the cache agree on one spelling. */
export const avatarCacheKey = (name: string, revision: number): string => `${name}:${revision}`
