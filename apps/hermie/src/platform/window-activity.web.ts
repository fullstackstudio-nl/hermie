/**
 * A browser tab's window is always active, as far as this app is concerned.
 *
 * Read `window-activity.ts` first: the question exists because a Mac window that
 * is not key draws every `UIVisualEffectView` in it dimmed, and the app's glass
 * is made of those. On the web the glass is `backdrop-filter` — a CSS property
 * on our own element, with no window state in it — so a blurred panel in a
 * background tab looks exactly like a blurred panel in a foreground one, and
 * there is nothing for this seam to protect against.
 *
 * So it answers the constant rather than watching `focus`/`blur` or
 * `document.hasFocus()`. Wiring those up would swap every glass surface in the
 * page for its solid rung whenever the reader clicked into another tab — a
 * restyle invented by this file to fix a problem the platform does not have,
 * which is the opposite of the requirement.
 */

/** Always true. The web has no window state that reaches a material. */
export function isWindowActive(): boolean {
  return true
}

/** Never fires, and says so by returning a no-op unsubscribe. */
export function subscribeToWindowActivity(_handler: (active: boolean) => void): () => void {
  return () => undefined
}
