/**
 * What the reader has decided about voice.
 *
 * A store of its own rather than three more fields on `store/settings.ts`, and
 * the reason is ownership rather than taste: that store is the app-wide
 * preference blob several surfaces write to, and voice is a feature that can be
 * removed in one directory. Its own key also means a voice preference cannot
 * corrupt the chat-view blob if an older build reads it — the defensive readers
 * below are per-field for the same reason every other store here has them.
 *
 * It is deliberately NOT synced through `ui_meta` (ADR-0016). A speaking rate is
 * a fact about the DEVICE — its speaker, and whoever is near it — and carrying it
 * to a second device would take the wrong answer with it. "Read replies aloud
 * automatically" is the one that could argue for syncing, and it does not win the
 * argument either: a phone in a car and a Mac in an office want different answers
 * for the same chat.
 */
import { create } from 'zustand'

import { keyValueStore } from '../../platform/key-value-store'

export const VOICE_SETTINGS_KEY = 'hermie.voice'

/** The slowest and fastest the rate control offers, as engine multipliers. */
export const RATE_RANGE = { min: 0.5, max: 1.5 } as const

export const DEFAULT_RATE = 1

/** The five stops on the rate control. A slider would promise a precision no engine has. */
export const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5] as const

export interface VoiceSettingsState {
  /** Speaking rate, 1 being the platform's own normal. */
  rate: number
  /** Stop reading when the app goes to the background. */
  stopOnBackground: boolean
  /** Per chat: read each completed reply without being asked. Off unless present. */
  autoReadByChat: Record<string, boolean>
  loaded: boolean
  hydrate: () => Promise<void>
  setRate: (rate: number) => void
  setStopOnBackground: (value: boolean) => void
  setAutoRead: (botName: string, value: boolean) => void
  reset: () => void
}

interface PersistedVoice {
  rate?: number
  stopOnBackground?: boolean
  autoReadByChat?: Record<string, boolean>
}

/**
 * A stored rate, clamped and defaulted.
 *
 * Clamped rather than rejected: a value from an older build or a hand-edited
 * file is a value somebody meant, and 3.0 spoken at 1.5 is closer to the
 * intention than 3.0 discarded to 1.0. A non-number is not a rate at all.
 */
export function asRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(RATE_RANGE.max, Math.max(RATE_RANGE.min, value))
    : undefined
}

function asAutoRead(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}

  for (const [bot, flag] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    // Only the `true`s are kept. Off is the default, so a stored `false` is a
    // row that says nothing — and a map that accumulates one entry per chat the
    // reader ever opened is a map that grows for no reason.
    if (flag === true && bot) {
      out[bot] = true
    }
  }

  return out
}

let writeQueue: Promise<void> = Promise.resolve()

function persist(state: PersistedVoice): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(VOICE_SETTINGS_KEY, state))
    .catch(() => {
      // A preference that did not persist resets on the next launch. Not an error.
    })
}

export const useVoiceSettingsStore = create<VoiceSettingsState>((set, get) => {
  const save = (): void => {
    const { autoReadByChat, rate, stopOnBackground } = get()

    persist({ autoReadByChat, rate, stopOnBackground })
  }

  return {
    rate: DEFAULT_RATE,
    stopOnBackground: true,
    autoReadByChat: {},
    loaded: false,

    async hydrate() {
      const stored = await keyValueStore.getJson<PersistedVoice>(VOICE_SETTINGS_KEY)

      set({
        rate: asRate(stored?.rate) ?? DEFAULT_RATE,
        stopOnBackground: stored?.stopOnBackground !== false,
        autoReadByChat: asAutoRead(stored?.autoReadByChat),
        loaded: true
      })
    },

    setRate(rate) {
      set({ rate: asRate(rate) ?? DEFAULT_RATE })
      save()
    },

    setStopOnBackground(stopOnBackground) {
      set({ stopOnBackground })
      save()
    },

    setAutoRead(botName, value) {
      const autoReadByChat = { ...get().autoReadByChat }

      if (value) {
        autoReadByChat[botName] = true
      } else {
        delete autoReadByChat[botName]
      }

      set({ autoReadByChat })
      save()
    },

    reset() {
      set({
        rate: DEFAULT_RATE,
        stopOnBackground: true,
        autoReadByChat: {},
        loaded: false
      })
    }
  }
})

/** Whether this chat reads its replies without being asked. */
export function autoReadFor(state: VoiceSettingsState, botName: string): boolean {
  return state.autoReadByChat[botName] === true
}
