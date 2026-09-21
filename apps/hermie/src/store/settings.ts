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
import {
  DEFAULT_THEME_CHOICE,
  isThemePresetName,
  THEME_PRESETS,
  type ThemeChoice,
  type ThemePresetName,
  type UserTheme,
  type UserThemeFace
} from '../ui/themes'

/** `system` follows the OS; the other two pin the app regardless of it. */
export type Appearance = 'system' | 'light' | 'dark'

export const DEFAULT_APPEARANCE: Appearance = 'system'

export interface ChatViewSettings {
  level: Verbosity
  showBotToBot: boolean
  showThinking: boolean
}

/** The defaults: Quiet, bot-to-bot traffic visible, thinking folded away. Quiet is what a
 * messenger looks like; the tool cards are one tap away in the chat options. */
export const DEFAULT_CHAT_VIEW: ChatViewSettings = {
  level: 'quiet',
  showBotToBot: true,
  showThinking: false
}

export const CHAT_VIEW_KEY = 'hermie.chat.view'

interface PersistedChatView {
  defaults: ChatViewSettings
  perChat: Record<string, Partial<ChatViewSettings>>
  appearance?: Appearance
  themeChoice?: ThemeChoice
  userThemes?: UserTheme[]
  /** What Part 2 wrote before a theme was a theme. Read, never written. */
  wallpaper?: string
}

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']

const asAppearance = (value: unknown): Appearance | undefined =>
  typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value) ? (value as Appearance) : undefined

/**
 * What a wallpaper name from an older build becomes.
 *
 * `warm` had no successor and falls back to Blue. `slate` becomes Graphite, which
 * is the same composition it was: a matte floor whose panels sit a step above it,
 * neutral now rather than grey-blue. Anything unrecognised is ignored, which
 * leaves the default.
 */
const RETIRED_WALLPAPERS: Record<string, ThemePresetName> = {
  blue: 'blue',
  warm: 'blue',
  graphite: 'graphite',
  slate: 'graphite'
}

const asFace = (value: unknown): UserThemeFace | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const raw = value as Record<string, unknown>
  const hex = (input: unknown): string | undefined =>
    typeof input === 'string' && /^#[0-9a-f]{6}$/iu.test(input) ? input : undefined

  const face: UserThemeFace = {
    ...(hex(raw.background) ? { background: hex(raw.background) as string } : {}),
    ...(hex(raw.accentFill) ? { accentFill: hex(raw.accentFill) as string } : {}),
    ...(hex(raw.accentBubble) ? { accentBubble: hex(raw.accentBubble) as string } : {})
  }

  return Object.keys(face).length ? face : undefined
}

/** Read the reader's own themes defensively: they arrive from disk AND from a gateway. */
export function asUserThemes(value: unknown): UserTheme[] {
  const out: UserTheme[] = []
  const seen = new Set<string>()

  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const raw = entry as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : ''

    // An id is how a choice points at a theme, so a row without one — or a
    // duplicate, which would make the pointer ambiguous — is not a theme.
    if (!id || seen.has(id) || !isThemePresetName(raw.base)) {
      continue
    }

    seen.add(id)

    const light = asFace(raw.light)
    const dark = asFace(raw.dark)

    out.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : '',
      base: raw.base,
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {})
    })
  }

  return out
}

/** Read a stored theme choice, folding the retired wallpaper names into it. */
export function asThemeChoice(value: unknown, legacyWallpaper?: unknown): ThemeChoice | undefined {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>

    if (raw.kind === 'preset' && isThemePresetName(raw.name)) {
      return { kind: 'preset', name: raw.name }
    }

    if (raw.kind === 'user' && typeof raw.id === 'string' && raw.id) {
      return { kind: 'user', id: raw.id }
    }
  }

  if (typeof legacyWallpaper === 'string' && RETIRED_WALLPAPERS[legacyWallpaper]) {
    return { kind: 'preset', name: RETIRED_WALLPAPERS[legacyWallpaper] as ThemePresetName }
  }

  return undefined
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
  appearance: Appearance
  /** Which theme the glass floats over: a preset, or one of the reader's own. */
  themeChoice: ThemeChoice
  /** Themes the reader made. App-wide, and ADR-0016's `hermie-app` carries them. */
  userThemes: UserTheme[]
  /** False until the first disk read finishes; screens paint the defaults meanwhile. */
  loaded: boolean
  hydrate: () => Promise<void>
  setDefaults: (patch: Partial<ChatViewSettings>) => void
  setChatView: (botName: string, patch: Partial<ChatViewSettings>) => void
  resetChatView: (botName: string) => void
  setAppearance: (appearance: Appearance) => void
  setThemeChoice: (choice: ThemeChoice) => void
  /** Copy a preset into a theme of the reader's own, and return its id. */
  createUserTheme: (base: ThemePresetName, name: string) => string
  renameUserTheme: (id: string, name: string) => void
  /** Patch one scheme's face. A colour of `null` goes back to following the preset. */
  editUserTheme: (id: string, scheme: 'light' | 'dark', patch: Record<string, string | null>) => void
  deleteUserTheme: (id: string) => void
  /**
   * Replace the app-wide half wholesale, without writing it back out.
   *
   * ADR-0016's reconcile hands the gateway's copy of this section straight in, so
   * the setter is deliberately silent: persisting here would write the value that
   * just arrived back to the place it came from, on every reconnect.
   */
  applyAppSettings: (patch: {
    defaults?: ChatViewSettings
    themeChoice?: ThemeChoice
    userThemes?: UserTheme[]
  }) => void
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

/**
 * A user theme's id, unique enough for a set of themes one person made.
 *
 * It has to survive travelling to a second device through `hermie-app`, so it is
 * a value rather than an index: two phones both appending a theme would otherwise
 * both call it number three.
 */
let themeCounter = 0

function newThemeId(): string {
  themeCounter += 1

  return `t${Date.now().toString(36)}${themeCounter.toString(36)}`
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  /** Write whatever is in the store now; every setter calls this after its `set`. */
  const save = (): void => {
    const { defaults, perChat, appearance, themeChoice, userThemes } = get()

    persist({ defaults, perChat, appearance, themeChoice, userThemes })
  }

  const writeThemes = (userThemes: UserTheme[]): void => {
    set({ userThemes })
    save()
  }

  return {
    defaults: DEFAULT_CHAT_VIEW,
    perChat: {},
    appearance: DEFAULT_APPEARANCE,
    themeChoice: DEFAULT_THEME_CHOICE,
    userThemes: [],
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
        themeChoice: asThemeChoice(stored?.themeChoice, stored?.wallpaper) ?? DEFAULT_THEME_CHOICE,
        userThemes: asUserThemes(stored?.userThemes),
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

    setThemeChoice(themeChoice) {
      set({ themeChoice })
      save()
    },

    createUserTheme(base, name) {
      const id = newThemeId()
      const preset = THEME_PRESETS[base]

      // The new theme starts as a COPY of the preset's two backgrounds rather
      // than as an empty shell, so the editor has something to show and an edit
      // to one face cannot look like it moved the other.
      writeThemes([
        ...get().userThemes,
        {
          id,
          name,
          base,
          light: { background: preset.light.background },
          dark: { background: preset.dark.background }
        }
      ])

      return id
    },

    renameUserTheme(id, name) {
      writeThemes(get().userThemes.map(theme => (theme.id === id ? { ...theme, name } : theme)))
    },

    editUserTheme(id, scheme, patch) {
      writeThemes(
        get().userThemes.map(theme => {
          if (theme.id !== id) {
            return theme
          }

          const face: Record<string, string> = { ...(theme[scheme] ?? {}) }

          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete face[key]
            } else {
              face[key] = value
            }
          }

          return { ...theme, [scheme]: face as UserThemeFace }
        })
      )
    },

    deleteUserTheme(id) {
      const userThemes = get().userThemes.filter(theme => theme.id !== id)
      const choice = get().themeChoice

      // Deleting the theme that is ON must leave a window that can still be read,
      // so the choice falls back to the base it was built from rather than to a
      // pointer at nothing. `resolveThemeFace` would survive the dangling id on
      // its own; this is so the picker agrees with what is on screen.
      const removed = get().userThemes.find(theme => theme.id === id)

      set({
        userThemes,
        ...(choice.kind === 'user' && choice.id === id
          ? { themeChoice: { kind: 'preset' as const, name: removed?.base ?? 'blue' } }
          : {})
      })
      save()
    },

    applyAppSettings(patch) {
      set({
        ...(patch.defaults ? { defaults: patch.defaults } : {}),
        ...(patch.themeChoice ? { themeChoice: patch.themeChoice } : {}),
        ...(patch.userThemes ? { userThemes: patch.userThemes } : {})
      })
    },

    reset() {
      set({
        defaults: DEFAULT_CHAT_VIEW,
        perChat: {},
        appearance: DEFAULT_APPEARANCE,
        themeChoice: DEFAULT_THEME_CHOICE,
        userThemes: [],
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
