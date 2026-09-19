/**
 * The bot roster.
 *
 * A bot is a Hermes profile. Everything the list shows is derived rather than
 * stored twice: `running` comes from `session.active_list`, unread from the
 * canonical chat's `last_active` against a per-bot watermark, and "needs input"
 * from the open requests the chat store is already holding. The roster itself
 * is cached so the list paints on launch instead of after a round trip.
 */
import type { ProfileRow } from '@hermes/shared/gateway-contract'
import { create } from 'zustand'

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
  /** Bots with a live session on the gateway right now. */
  running: Record<string, true>
  /** name → the `last_active` the user has already looked at. */
  lastSeen: Record<string, number>
  loading: boolean
  error: string | null
  /** `Date.now()` of the last successful roster read; null while only the cache is painted. */
  refreshedAt: number | null

  setBots: (bots: Bot[], options?: { fromCache?: boolean }) => void
  setAvatar: (name: string, revision: number, dataUrl: string | null) => void
  setRunning: (names: readonly string[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  hydrateLastSeen: () => Promise<void>
  markSeen: (name: string, lastActive?: number) => void
  reset: () => void
}

const INITIAL = {
  bots: [] as Bot[],
  byName: {} as Record<string, Bot>,
  avatars: {} as Record<string, string>,
  avatarsFetched: {} as Record<string, true>,
  running: {} as Record<string, true>,
  lastSeen: {} as Record<string, number>,
  loading: false,
  error: null as string | null,
  refreshedAt: null as number | null
}

let lastSeenQueue: Promise<void> = Promise.resolve()

function persistLastSeen(lastSeen: Record<string, number>): void {
  lastSeenQueue = lastSeenQueue
    .then(() => keyValueStore.setJson(BOT_LAST_SEEN_KEY, lastSeen))
    .catch(() => {
      // A lost watermark shows one chat as unread again; not worth an error.
    })
}

export const useBotsStore = create<BotsState>((set, get) => ({
  ...INITIAL,

  setBots(bots, options = {}) {
    const byName: Record<string, Bot> = {}

    for (const bot of bots) {
      byName[bot.name] = bot
    }

    set({
      bots,
      byName,
      ...(options.fromCache ? {} : { refreshedAt: Date.now(), error: null })
    })
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

  async hydrateLastSeen() {
    const stored = await keyValueStore.getJson<Record<string, number>>(BOT_LAST_SEEN_KEY)
    const lastSeen: Record<string, number> = {}

    for (const [name, value] of Object.entries(stored ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        lastSeen[name] = value
      }
    }

    set({ lastSeen })
  },

  markSeen(name, lastActive) {
    const bot = get().byName[name]
    const at = lastActive ?? bot?.canonical?.lastActive ?? Math.floor(Date.now() / 1000)
    const current = get().lastSeen[name] ?? 0

    if (at <= current) {
      return
    }

    const lastSeen = { ...get().lastSeen, [name]: at }

    set({ lastSeen })
    persistLastSeen(lastSeen)
  },

  reset() {
    set(INITIAL)
  }
}))

/**
 * Unread is "the canonical chat moved since the user last looked at it". It is
 * deliberately a timestamp comparison rather than a counter: the gateway is the
 * only thing that knows how much happened, and it only reports `last_active`.
 */
export function isUnread(state: BotsState, name: string): boolean {
  const lastActive = state.byName[name]?.canonical?.lastActive ?? 0

  return lastActive > 0 && lastActive > (state.lastSeen[name] ?? 0)
}

/** The avatar cache key; exported so the loader and the cache agree on one spelling. */
export const avatarCacheKey = (name: string, revision: number): string => `${name}:${revision}`
