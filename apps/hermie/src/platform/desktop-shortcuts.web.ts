/**
 * The browser's answer to `desktop-shortcuts.ts`.
 *
 * Read that file first: it is the whole table, and it is a `HermieMac` native
 * module or nothing. In a tab it was nothing — `requireOptionalNativeModule`
 * returns null, `subscribeToShortcuts` subscribed to a module that is not
 * there, and every shortcut in the app was dead on the web. Not only ⌘K: ⌘1…9,
 * ⌘↑/⌘↓, ⇧⌘S and the composer's own bare ↑, ↓ and Tab all came down the same
 * road, so the slash list could not be driven from the keyboard either. Escape
 * kept working because it arrives through `keyboard-modifiers.web.ts`, which is
 * a different seam — which is exactly why nobody noticed.
 *
 * ## The chords are the Mac's, deliberately
 *
 * `HermieMacModule.swift::shortcut(for:input:)` is the source of truth and this
 * is a transcription of it, down to ⇧⌘S accepting Control as well as Command.
 * A browser table that drifted from the window one would be two tables to keep
 * in agreement for a reader who uses both.
 *
 * ## What the browser takes back
 *
 * ⌘W closes the tab and is not preventable, and ⌘, belongs to the browser on
 * some platforms. Those are the user agent's to keep. Everything else is
 * prevented ONLY when a screen actually took it (`handler` says so), so a bare
 * Tab still moves focus while no suggestion list is open, and ⌘K still reaches
 * the address bar on a screen that has no search.
 *
 * ## Capture, like Escape
 *
 * The same reasoning as `subscribeToEscape`: the surface a shortcut is for is
 * usually not the one holding the caret, and a `keydown` that stops at a
 * focused text field would make ⌘K work everywhere except inside the composer.
 */

import type { ShortcutAction, ShortcutEvent } from './desktop-shortcuts.shared'

export {
  DOUBLE_FIRE_MS,
  isDoubleFire,
  isMenuBarInstalled,
  setMenuBar,
  type MenuBarTitles,
  type ShortcutAction,
  type ShortcutEvent
} from './desktop-shortcuts.shared'

/** The digits ⌘1…⌘9 map to, in order. */
const NUMBERED: readonly ShortcutAction[] = [
  'chat1',
  'chat2',
  'chat3',
  'chat4',
  'chat5',
  'chat6',
  'chat7',
  'chat8',
  'chat9'
]

/**
 * Which action this keystroke is, or null.
 *
 * Exported for its own test: the table is the part that can silently disagree
 * with the Swift one, and a test that has to synthesise a `keydown` to read it
 * would be testing the browser rather than the table.
 *
 * `event.code` for the digits rather than `event.key`, because a keyboard layout
 * that puts a symbol on the unshifted digit row — French AZERTY does — would
 * otherwise have no ⌘1…9 at all.
 */
export function shortcutForKey(event: {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): ShortcutAction | null {
  const { altKey, code, ctrlKey, key, metaKey, shiftKey } = event

  if (altKey) {
    return null
  }

  if (shiftKey && (metaKey || ctrlKey) && key.toLowerCase() === 's') {
    return 'toggleSidebar'
  }

  if (shiftKey) {
    return null
  }

  if (ctrlKey && !metaKey && key === 'Tab') {
    return 'nextChat'
  }

  // Bare ↑, ↓ and Tab: the composer's slash list, and the only unmodified keys
  // on this table. None of the three inserts a character, so nothing typed into
  // a field crosses over, and all three are ignored unless a list is open.
  if (!metaKey && !ctrlKey) {
    switch (key) {
      case 'ArrowUp':
        return 'suggestionUp'
      case 'ArrowDown':
        return 'suggestionDown'
      case 'Tab':
        return 'suggestionAccept'
      default:
        return null
    }
  }

  if (!metaKey) {
    return null
  }

  switch (key) {
    case 'k':
    case 'K':
      return 'search'
    case ',':
      return 'settings'
    case 'w':
    case 'W':
      return 'close'
    case 'ArrowUp':
      return 'previousChat'
    case 'ArrowDown':
      return 'nextChat'
    default:
      break
  }

  const digit = code.startsWith('Digit') ? Number.parseInt(code.slice(5), 10) : Number.NaN

  return digit >= 1 && digit <= 9 ? (NUMBERED[digit - 1] ?? null) : null
}

/**
 * Does a text field hold the caret?
 *
 * The same question `HermieMacModule` answers from the responder chain, asked of
 * the document instead. A `contenteditable` counts: the markdown surface uses
 * one, and a reader typing in it is as much "typing" as one in the composer.
 */
export function typingNow(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement

  if (!active) {
    return false
  }

  const tag = active.tagName

  return tag === 'INPUT' || tag === 'TEXTAREA' || (active as HTMLElement).isContentEditable === true
}

export function subscribeToShortcuts(handler: (event: ShortcutEvent) => boolean | void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: KeyboardEvent): void => {
    // A key being held down is one press for this table: ⌘K repeating would
    // reopen the search screen under the reader's own typing.
    if (event.repeat) {
      return
    }

    const action = shortcutForKey(event)

    if (!action) {
      return
    }

    if (handler({ action, typing: typingNow() }) === true) {
      event.preventDefault()
    }
  }

  window.addEventListener('keydown', listener, true)

  return () => window.removeEventListener('keydown', listener, true)
}
