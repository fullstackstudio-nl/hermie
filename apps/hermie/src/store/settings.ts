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
 */
import type { Verbosity } from '@hermie/transcript'
import { create } from 'zustand'

import { keyValueStore } from '../platform/key-value-store'

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
}

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
  /** False until the first disk read finishes; screens paint the defaults meanwhile. */
  loaded: boolean
  hydrate: () => Promise<void>
  setDefaults: (patch: Partial<ChatViewSettings>) => void
  setChatView: (botName: string, patch: Partial<ChatViewSettings>) => void
  resetChatView: (botName: string) => void
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaults: DEFAULT_CHAT_VIEW,
  perChat: {},
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

    set({ defaults: { ...DEFAULT_CHAT_VIEW, ...asPatch(stored?.defaults) }, perChat, loaded: true })
  },

  setDefaults(patch) {
    const defaults = { ...get().defaults, ...patch }

    set({ defaults })
    persist({ defaults, perChat: get().perChat })
  },

  setChatView(botName, patch) {
    const perChat = { ...get().perChat, [botName]: { ...get().perChat[botName], ...patch } }

    set({ perChat })
    persist({ defaults: get().defaults, perChat })
  },

  resetChatView(botName) {
    const perChat = { ...get().perChat }

    delete perChat[botName]
    set({ perChat })
    persist({ defaults: get().defaults, perChat })
  },

  reset() {
    set({ defaults: DEFAULT_CHAT_VIEW, perChat: {}, loaded: false })
  }
}))

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
