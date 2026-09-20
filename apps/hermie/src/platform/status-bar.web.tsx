/**
 * The system status bar in a browser: there is none.
 *
 * A tab's chrome belongs to the browser, and the only thing a page can say
 * about it is `theme-color`, which affects the surrounding UI on mobile Safari
 * and Chrome rather than any ink the app draws. That is a document-level
 * concern the exported `index.html` owns, not a component, so this renders
 * nothing.
 */
import type { StatusBarInk } from './platform-contracts'

export type { StatusBarInk } from './platform-contracts'

export function SystemStatusBar(_props: { ink: StatusBarInk }) {
  return null
}
