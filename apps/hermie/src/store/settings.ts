/**
 * Display preferences for chats.
 *
 * Verbosity, the bot-to-bot toggle and the thinking toggle are read-time
 * decisions in `@hermie/transcript` — nothing here changes what is stored, only
 * what is shown — so they live in a plain preference store and are safe to flip
 * mid-turn.
 *
 * There is one global default and an optional per-chat override. A chat without
 * an override follows the default as the default moves; an override pins that
 * chat until it is reset. Both are persisted through the `KeyValueStore`.
 *
 * The appearance preference rides along here rather than in its own store: it
 * is the same blob on disk, read at the same moment, and a second store would
 * mean a second first-paint flash.
 */
import type { Verbosity } from '@hermie/transcript'
import { create } from 'zustand'

import { keyValueStore } from '../platform/key-value-store'
import { DEFAULT_WALLPAPER, WALLPAPER_ORDER, type WallpaperName } from '../ui/tokens'

/** `system` follows the OS; the other two pin the app regardless of it. */
export type Appearance = 'system' | 'light' | 'dark'

export const DEFAULT_APPEARANCE: Appearance = 'system'

export interface ChatViewSettings {
  level: Verbosity
  showBotToBot: boolean
  showThinking: boolean
}

/** The plan's defaults: Normal, bot-to-bot traffic visible, thinking folded away. */
export const DEFAULT_CHAT_VIEW: ChatViewSettings = {
  level: 'normal',
  showBotToBot: true,
  showThinking: false
}

export const CHAT_VIEW_KEY = 'hermie.chat.view'

interface PersistedChatView {
  defaults: ChatViewSettings
  perChat: Record<string, Partial<ChatViewSettings>>
  appearance?: Appearance
  wallpaper?: WallpaperName
}

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']

const asAppearance = (value: unknown): Appearance | undefined =>
  typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value) ? (value as Appearance) : undefined

const asWallpaper = (value: unknown): WallpaperName | undefined =>
  typeof value === 'string' && (WALLPAPER_ORDER as readonly string[]).includes(value)
    ? (value as WallpaperName)
    : undefined

const VERBOSITY: readonly Verbosity[] = ['quiet', 'normal', 'verbose']

const asVerbosity = (value: unknown): Verbosity | undefined =>
  typeof value === 'string' && (VERBOSITY as readonly string[]).includes(value) ? (value as Verbosity) : undefined

/** Read a stored blob defensively: an older build may have written anything. */
function asPatch(value: unknown): Partial<ChatViewSettings> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const raw = value as Record<string, unknown>
  const level = asVerbosity(raw.level)

  return {
    ...(level ? { level } : {}),
    ...(typeof raw.showBotToBot === 'boolean' ? { showBotToBot: raw.showBotToBot } : {}),
    ...(typeof raw.showThinking === 'boolean' ? { showThinking: raw.showThinking } : {})
  }
}

export interface SettingsState {
  defaults: ChatViewSettings
  perChat: Record<string, Partial<ChatViewSettings>>
  appearance: Appearance
  /** Which of the four flat wallpapers the glass floats over. */
  wallpaper: WallpaperName
  /** False until the first disk read finishes; screens paint the defaults meanwhile. */
  loaded: boolean
  hydrate: () => Promise<void>
  setDefaults: (patch: Partial<ChatViewSettings>) => void
  setChatView: (botName: string, patch: Partial<ChatViewSettings>) => void
  resetChatView: (botName: string) => void
  setAppearance: (appearance: Appearance) => void
  setWallpaper: (wallpaper: WallpaperName) => void
  reset: () => void
}

let writeQueue: Promise<void> = Promise.resolve()

/** Serialise the writes: two toggles flipped in the same tick must not race. */
function persist(state: PersistedChatView): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(CHAT_VIEW_KEY, state))
    .catch(() => {
      // A preference that failed to persist is a preference that resets on the
      // next launch, which is not worth surfacing as an error.
    })
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  /** Write whatever is in the store now; every setter calls this after its `set`. */
  const save = (): void => {
    const { defaults, perChat, appearance, wallpaper } = get()

    persist({ defaults, perChat, appearance, wallpaper })
  }

  return {
    defaults: DEFAULT_CHAT_VIEW,
    perChat: {},
    appearance: DEFAULT_APPEARANCE,
    wallpaper: DEFAULT_WALLPAPER,
    loaded: false,

    async hydrate() {
      const stored = await keyValueStore.getJson<PersistedChatView>(CHAT_VIEW_KEY)
      const perChat: Record<string, Partial<ChatViewSettings>> = {}

      for (const [bot, patch] of Object.entries(stored?.perChat ?? {})) {
        const parsed = asPatch(patch)

        if (Object.keys(parsed).length) {
          perChat[bot] = parsed
        }
      }

      set({
        defaults: { ...DEFAULT_CHAT_VIEW, ...asPatch(stored?.defaults) },
        perChat,
        appearance: asAppearance(stored?.appearance) ?? DEFAULT_APPEARANCE,
        wallpaper: asWallpaper(stored?.wallpaper) ?? DEFAULT_WALLPAPER,
        loaded: true
      })
    },

    setDefaults(patch) {
      set({ defaults: { ...get().defaults, ...patch } })
      save()
    },

    setChatView(botName, patch) {
      set({ perChat: { ...get().perChat, [botName]: { ...get().perChat[botName], ...patch } } })
      save()
    },

    resetChatView(botName) {
      const perChat = { ...get().perChat }

      delete perChat[botName]
      set({ perChat })
      save()
    },

    setAppearance(appearance) {
      set({ appearance })
      save()
    },

    setWallpaper(wallpaper) {
      set({ wallpaper })
      save()
    },

    reset() {
      set({
        defaults: DEFAULT_CHAT_VIEW,
        perChat: {},
        appearance: DEFAULT_APPEARANCE,
        wallpaper: DEFAULT_WALLPAPER,
        loaded: false
      })
    }
  }
})

/** True when this chat pins its own view rather than following the default. */
export function hasChatViewOverride(state: SettingsState, botName: string): boolean {
  return Object.keys(state.perChat[botName] ?? {}).length > 0
}

/** The effective view for one chat: the global default with its override folded in. */
export function chatViewFor(state: SettingsState, botName: string): ChatViewSettings {
  return { ...state.defaults, ...state.perChat[botName] }
}

/** Hook form of `chatViewFor`, for a screen that only cares about one chat. */
export function useChatView(botName: string): ChatViewSettings {
  const defaults = useSettingsStore(state => state.defaults)
  const override = useSettingsStore(state => state.perChat[botName])

  return { ...defaults, ...override }
}
