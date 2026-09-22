/**
 * Is this app's window the one the reader is working in?
 *
 * One question, asked for one reason: on a Mac a window that is not key draws
 * every `UIVisualEffectView` in it with the dimmed variant of its material, and
 * both of this app's glass materials — `UIGlassEffect` on iOS 26 and `expo-blur`
 * below it — are visual effect views. So clicking another app restyles Hermie's
 * chrome, which is exactly what the owner photographed on 2026-09-20.
 *
 * **There is no API to stop it.** That was looked for in the iOS 27 SDK rather
 * than assumed: `UIVisualEffectView` has three members and none of them is a
 * state, `UIGlassEffect` has `interactive` and `tintColor`, and nothing in
 * `UIKit.framework/Headers` names an inactive appearance at all. AppKit's
 * `NSVisualEffectView.state = .active` is the knob that exists, and a
 * "Designed for iPad" app is an unmodified iOS binary with no AppKit surface to
 * reach it through. `modules/hermie-mac/ios/HermieWindowActivity.swift` carries
 * the same list beside the code that replaced it.
 *
 * What is left is not to have a visual effect view on screen while the window is
 * inactive, and that decision belongs to `GlassSurface`: it already knows how to
 * draw every surface without one, because that is what Android and Reduce
 * Transparency get, and the elevation ladder is defined so the solid rung keeps
 * the same hierarchy. This file is only the fact.
 *
 * ## Why the answer is a constant `true` off a Mac
 *
 * `foregroundInactive` is a state a phone enters several times a minute — the
 * Control Centre sheet, the notification shade, a call banner, the app switcher.
 * Honouring it there would make every glass surface in the app blink to its
 * solid rung whenever somebody pulled down the shade, which is the same bug one
 * platform over. The native module installs no observer at all unless
 * `isiOSAppOnMac`, so this seam cannot report `false` on a phone even by
 * accident.
 *
 * Everything degrades to "always active": Android, the Jest environment, and a
 * binary built before this event existed. That is the behaviour the app had
 * before, which is the right thing for a missing module to fall back to.
 */
import { requireOptionalNativeModule } from 'expo'

type WindowActivityModule = {
  isWindowActive?: () => boolean
  addListener?: (event: string, listener: (payload: { active?: boolean }) => void) => { remove: () => void }
}

// A registry read, not a load: calling it twice hands back the same object, so
// the other three seams that ask for `HermieMac` cost nothing extra.
function nativeModule(): WindowActivityModule | null {
  try {
    return requireOptionalNativeModule<WindowActivityModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

/**
 * The answer right now.
 *
 * Read once for the first render, because the event only fires on a CHANGE: a
 * bundle that reloaded while the window was behind another would otherwise start
 * out believing it was in front and draw a dimmed material for one activation.
 */
export function isWindowActive(): boolean {
  try {
    // `!== false` rather than `=== true`: a module without the function is an
    // older binary under a newer bundle, and its windows are as active as they
    // ever were.
    return mac?.isWindowActive?.() !== false
  } catch {
    return true
  }
}

/**
 * Every change, while the process lives. Returns the unsubscribe.
 *
 * The payload is the new answer rather than a bare ping, so a listener that
 * misses one notification cannot drift out of step with the window.
 */
export function subscribeToWindowActivity(handler: (active: boolean) => void): () => void {
  const subscription = mac?.addListener?.('onWindowActive', payload => handler(payload?.active !== false))

  return () => subscription?.remove()
}
