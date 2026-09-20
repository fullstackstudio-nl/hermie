/**
 * The desktop keyboard's shortcuts, and the Mac's menu bar, as one seam.
 *
 * They are one seam because they are one event. A menu item in the Mac's menu bar
 * and the keystroke printed beside it must do the same thing, and the cheapest way
 * to guarantee that is for both to arrive as the same `onShortcut` — which is what
 * `HermieMenuBar` does natively, so nothing here has to know which of the two the
 * reader used.
 *
 * ## An allow-list, not a key event
 *
 * The native side emits only for a fixed table: ⌘K, ⌘,, ⌘W, ⌘⇧S, ⌘1…9, ⌘↑, ⌘↓,
 * ⌃Tab — and bare ↑, ↓ and Tab for the composer's slash list. It never emits for
 * a key that INSERTS TEXT, which matters more than it looks: the handler it reads
 * from is GameController's, below the responder chain, so it sees every keystroke
 * in the app including the ones typed into the composer and into a password
 * field. A letter has no path to JavaScript through here; an arrow key carries
 * nothing to leak.
 *
 * ⌘⇧S is the one entry that WANTS Shift, and the native table had to be opened for
 * it: everything else is disqualified by Shift on purpose, so that ⌘⇧K cannot be
 * mistaken for ⌘K. It is matched on the full combination rather than by relaxing
 * that rule — see `HermieMacModule.swift`.
 *
 * ## Why not `UIKeyCommand` for the keyboard half
 *
 * The same reason Escape is not one (see `keyboard-modifiers.ts`): a `UIKeyCommand`
 * lives in the responder chain, and a presented `Modal` leaves it. A shortcut that
 * stops working while a sheet is open is a shortcut nobody trusts. The menu bar's
 * items ARE key commands, because a menu bar has no alternative — and they route to
 * this same event, so the two paths cannot drift.
 *
 * Everything degrades to "no keyboard and no menu bar": a subscription that never
 * fires and a `setMenuBar` that reaches nothing. That is the honest answer on a
 * phone, on Android and in the Jest environment.
 */
import { requireOptionalNativeModule } from 'expo'

/** Every action the native allow-list can emit. Anything else is ignored here too. */
export type ShortcutAction =
  | 'search'
  | 'settings'
  | 'close'
  | 'toggleSidebar'
  | 'nextChat'
  | 'previousChat'
  | 'chat1'
  | 'chat2'
  | 'chat3'
  | 'chat4'
  | 'chat5'
  | 'chat6'
  | 'chat7'
  | 'chat8'
  | 'chat9'
  /** The composer's slash list: bare ↑, ↓ and Tab, ignored while it is closed. */
  | 'suggestionUp'
  | 'suggestionDown'
  | 'suggestionAccept'

const ACTIONS: readonly ShortcutAction[] = [
  'search',
  'settings',
  'close',
  'toggleSidebar',
  'nextChat',
  'previousChat',
  'chat1',
  'chat2',
  'chat3',
  'chat4',
  'chat5',
  'chat6',
  'chat7',
  'chat8',
  'chat9',
  'suggestionUp',
  'suggestionDown',
  'suggestionAccept'
]

/** The wording the Mac's menu bar shows. Sent from JavaScript so `strings.ts` stays the only copy. */
export interface MenuBarTitles {
  /** The menu's own name in the bar. */
  chats: string
  search: string
  settings: string
  close: string
  /**
   * "Hide Sidebar" or "Show Sidebar" — the caller picks, because only the caller
   * knows which one is true.
   *
   * The one menu item in the bar whose WORDING is state, which is why it is a
   * single key rather than two: the Swift side builds whatever string it is
   * handed and holds no opinion about the sidebar, so the two cannot disagree
   * about which way round they are.
   */
  toggleSidebar: string
}

type ShortcutModule = {
  addListener?: (event: string, listener: (payload: { action?: string }) => void) => { remove: () => void }
  setMenuBar?: (titles: Record<string, string>, chats: string[]) => Promise<void>
  isMenuBarInstalled?: () => boolean
}

function nativeModule(): ShortcutModule | null {
  try {
    return requireOptionalNativeModule<ShortcutModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

function isAction(value: unknown): value is ShortcutAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
}

/**
 * Every shortcut, while the app is in front. Returns the unsubscribe.
 *
 * Callers should go through `useShortcut`, which keeps one native subscription and
 * decides which of several registered screens an action belongs to.
 */
export function subscribeToShortcuts(handler: (action: ShortcutAction) => void): () => void {
  const subscription = mac?.addListener?.('onShortcut', payload => {
    if (isAction(payload?.action)) {
      handler(payload.action)
    }
  })

  return () => subscription?.remove()
}

/**
 * Put Hermie's own menu in the Mac's menu bar.
 *
 * `chats` is the visible chat list in its own order; the native side keeps the
 * first nine, which is as many as ⌘1…9 can reach. An empty array is a legitimate
 * call and clears the numbered section — which is what a signed-out app should
 * show, rather than nine stale names.
 *
 * Never throws and never awaited by a caller: a menu bar that does not exist is
 * the normal case on a phone.
 */
export function setMenuBar(titles: MenuBarTitles, chats: readonly string[]): void {
  try {
    void mac?.setMenuBar?.({ ...titles }, [...chats])?.catch(() => {
      // A Mac-only rebuild that fails is a cosmetic loss, not a failure worth
      // surfacing to somebody who was reading a chat list.
    })
  } catch {
    // Same, for a synchronous throw from a module that does not have the function.
  }
}

/** Whether the menu-bar hook reached the app delegate. Reported on the developer screen. */
export function isMenuBarInstalled(): boolean {
  try {
    return mac?.isMenuBarInstalled?.() === true
  } catch {
    return false
  }
}
