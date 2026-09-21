/**
 * The desktop keyboard's shortcuts, and the Mac's menu bar, as one seam.
 *
 * The parts BOTH platforms share: the action table, the menu bar, and the
 * double-fire rule. What differs is where the keystroke comes from, and that is
 * `subscribeToShortcuts` — the Mac's `HermieMac` module in `desktop-shortcuts.ts`,
 * a `keydown` listener in `desktop-shortcuts.web.ts`. Nothing imports this file
 * directly; import `./desktop-shortcuts` and let the bundler pick.
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
 * ## Why an event and not a bare action
 *
 * The allow-list is a table of KEYS, and "is this keystroke meant for the app or
 * for the field the caret is in" is not a question a key code can answer. The
 * owner's report from build 163 is what it looks like when nobody asks it: a `k`
 * typed into the theme editor moved the focus to the chat list's search field.
 * The proximate cause was a modifier the poll believed was still held (see
 * `HermieMacModule.swift`), but a table that only ever emits under a modifier is
 * one guess away from that every time, so the answer travels WITH the event:
 *
 *  - **`typing`** — a text view or a text field is the first responder. The
 *    keyboard path is below the responder chain and has no arbitration of its
 *    own, so it says so and `useShortcut` decides.
 *  - The MENU BAR path reports `typing: false` whatever is focused, and that is
 *    not an oversight. A menu item's key equivalent is a `UIKeyCommand` in the
 *    responder chain: the focused text view has already had its chance to claim
 *    the keystroke and did not, so the arbitration has happened.
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

/**
 * One shortcut, and what the app was doing when it arrived.
 *
 * `typing` defaults to false for a build whose native side predates it — an
 * older binary under a newer bundle — which keeps that combination behaving
 * exactly as it did rather than silently swallowing every shortcut.
 */
export interface ShortcutEvent {
  action: ShortcutAction
  /** A `UITextView` or `UITextField` holds the caret right now. */
  typing: boolean
}

type ShortcutModule = {
  addListener?: (
    event: string,
    listener: (payload: { action?: string; typing?: boolean }) => void
  ) => { remove: () => void }
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

/** The Mac module, or null everywhere else. `desktop-shortcuts.ts` subscribes through it. */
export const macShortcuts = nativeModule()

/** Is this string one of the actions the table can emit? Anything else is ignored. */
export function isAction(value: unknown): value is ShortcutAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
}

/**
 * How close together two reports of one chord have to be to be the same press.
 *
 * On a Mac both halves of the seam are live at once, and ⌘W is in both: the menu
 * bar's `UIKeyCommand` and GameController's `keyChangedHandler` each report it,
 * so one press arrived as two events and `closeTopmost()` closed two levels.
 *
 * **Suppressing one of the two paths is the fix that does not work**, and it is
 * worth writing down beside the one that does. The obvious move is to ignore the
 * keyboard path for anything the menu also provides — and the menu path is a
 * responder-chain path, which is precisely the thing a presented `Modal` takes
 * the app out of. ⌘W's whole job is closing a sheet. Suppressing the keyboard
 * path would leave it working everywhere except the one place it is for.
 *
 * So both paths stay live and the DISPATCHER collapses the pair. Fifty
 * milliseconds is chosen against what it has to separate: the two reports of one
 * press are the same run loop turn apart, and the fastest a person can press the
 * same chord twice on purpose is an order of magnitude slower than a key repeat
 * delay. Nothing legitimate lives in this window.
 */
export const DOUBLE_FIRE_MS = 50

/**
 * Is this report the second half of a press already dispatched?
 *
 * Exported for its own test, because the thing it decides is invisible from
 * outside: both paths produce an identical `action`, and the only difference
 * between "one press seen twice" and "two presses" is the clock.
 *
 * The FIRST report wins. Which of the two paths that is depends on the OS and is
 * not something this side can pin down, which is the honest reason it is not
 * chosen: what matters is that exactly one survives, and both carry the same
 * action. They can disagree about `typing` — the menu path always reports false,
 * because a `UIKeyCommand` is in the responder chain and the focused field was
 * offered the keystroke first and declined it — so the survivor's answer is
 * whichever arrived first, and for ⌘W nothing reads it.
 */
export function isDoubleFire(
  previous: { action: ShortcutAction; at: number } | null,
  next: { action: ShortcutAction; at: number }
): boolean {
  if (!previous || previous.action !== next.action) {
    return false
  }

  return next.at - previous.at < DOUBLE_FIRE_MS
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
    void macShortcuts?.setMenuBar?.({ ...titles }, [...chats])?.catch(() => {
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
    return macShortcuts?.isMenuBarInstalled?.() === true
  } catch {
    return false
  }
}
