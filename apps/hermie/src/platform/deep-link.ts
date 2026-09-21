/**
 * `hermie://chat/<bot>` — the one link this app answers, and the seam that
 * delivers it.
 *
 * Until the widgets there was nothing to deliver: ADR-0004 keeps the sign-in
 * round trip inside a WebView precisely so that no link has to come back to the
 * app, and `docs/platform-notes.md` recorded "nothing is registered with the
 * system" as one of the three gates on the development launch arguments. The
 * URL SCHEME was registered anyway — Expo writes `CFBundleURLTypes` and the
 * Android intent filter from `scheme` in app.config.ts — so what was missing was
 * a reader, not a registration.
 *
 * Two halves, deliberately separate:
 *
 *  - `parseHermieLink` is pure, so every way a link can be malformed is a table
 *    in a test rather than something discovered on a home screen.
 *  - `useHermieLink` is the React half: the cold-start URL and the warm one, in
 *    one hook, with the ordering problem handled once.
 *
 * **The grammar is narrow on purpose.** A URL scheme is registered with the
 * system, which means any app on the device and any web page the reader taps can
 * send one. So this parses exactly one shape and answers `null` for everything
 * else: no gateway address, no token, no screen id, nothing that could make the
 * app do something the owner did not ask for. Opening a chat that already exists
 * is the whole of what a link may do.
 */
import { requireOptionalNativeModule } from 'expo'
import { useEffect, useRef } from 'react'
import { Linking } from 'react-native'

/**
 * The URL this process was launched by, read once and then forgotten.
 *
 * `Linking.getInitialURL()` cannot answer it on iOS. Under the UIKit scene life cycle
 * (`modules/hermie-scene`) a cold-start URL arrives in the SCENE's connection options rather than in
 * the app delegate's launch options, which is the only place React Native looks — and in a build
 * that links expo-dev-client, which is every build made from this repository, the dev launcher sees
 * it before `RCTLinkingManager` does and shows its own screen instead of passing it on. Both were
 * measured on a simulator on 2026-09-21; the widgets section of docs/platform-notes.md has the two
 * screenshots.
 *
 * So the scene delegate records it before either can lose it and hands it over here. `consume`
 * rather than `get`: a launch URL is true for the life of the process, so anything that merely
 * reads it answers the same link to every caller forever, and a hook that remounts — or a Fast
 * Refresh — would reopen the launch chat.
 *
 * `requireOptionalNativeModule` for the reason `runs-on-mac.ts` gives: Android, the web and the
 * Jest environment have no such module, and there the honest answer is "nothing", not an error.
 * Android needs none of this — `getInitialURL()` reads the activity's intent and works.
 */
function consumeNativeLaunchURL(): string | null {
  try {
    return requireOptionalNativeModule<{ consumeLaunchURL(): string | null }>('HermieScene')?.consumeLaunchURL() ?? null
  } catch {
    // An older installed binary against a newer bundle: the module is there and
    // the function is not.
    return null
  }
}

/** What a link asked for. One kind today; a union because a second is likely. */
export type HermieLink = { kind: 'chat'; bot: string }

/**
 * `hermie://chat/<bot>`, or nothing.
 *
 * `exp+hermie://` is accepted alongside it because that is the scheme a dev
 * client registers and uses, so a link tested in development is the same link.
 * The bot name is percent-decoded and then checked: an empty one, a path with
 * more segments than one, and anything with a slash in it after decoding are all
 * rejected, which is what keeps a name from being read as a path.
 */
export function parseHermieLink(url: string | null | undefined): HermieLink | null {
  if (!url) {
    return null
  }

  const match = url.match(/^(?:exp\+)?hermie:\/\/chat\/([^/?#]+)\/?(?:[?#].*)?$/)

  if (!match?.[1]) {
    return null
  }

  let bot: string

  try {
    bot = decodeURIComponent(match[1])
  } catch {
    // A stray `%` is a malformed link, not a reason to throw inside a listener.
    return null
  }

  return bot && !bot.includes('/') ? { kind: 'chat', bot } : null
}

/**
 * Hand every `hermie://` link to `onLink`, cold start included.
 *
 * Two sources, and the whole difficulty is that they overlap.
 *
 * `getInitialURL()` answers the URL the app was LAUNCHED by and keeps answering
 * it for the life of the process, so it may only be acted on once — a second
 * reader would reopen the launch chat every time this hook remounted. The `url`
 * event, by contrast, has to be acted on EVERY time: tapping the same widget
 * twice is two requests to open that chat, not one repeated.
 *
 * Under the UIKit scene life cycle (`modules/hermie-scene`) a cold-start URL
 * arrives at the scene rather than in the launch options and is forwarded to the
 * app delegate, which reaches JavaScript as a `url` event — one that can fire
 * before this listener exists. So both paths are wired, and the first thing to
 * arrive, whichever it is, is what closes the launch question: an event marks
 * the launch as answered so the pending `getInitialURL` is dropped, and a
 * resolved `getInitialURL` does not stop any later event. See the widgets
 * section of docs/platform-notes.md for what was measured on a simulator.
 */
export function useHermieLink(onLink: (link: HermieLink) => void): void {
  // The handler is read through a ref so that the subscription is set up once:
  // a shell that rebuilds its callback on every render would otherwise detach
  // and reattach the listener constantly, and a link that lands in that gap is
  // gone.
  const handler = useRef(onLink)
  handler.current = onLink

  useEffect(() => {
    let live = true
    /** Whether the question "what launched this process" has been answered. */
    let launchAnswered = false

    const deliver = (url: string | null | undefined): void => {
      const link = parseHermieLink(url)

      if (live && link) {
        handler.current(link)
      }
    }

    const subscription = Linking.addEventListener('url', event => {
      launchAnswered = true
      deliver(event.url)
    })

    // Synchronously, before the listener above can have fired and before
    // `getInitialURL` resolves: this is the one source that is always right about
    // a cold start on iOS, and it is empty on every launch that was not one.
    const native = consumeNativeLaunchURL()

    if (native) {
      launchAnswered = true
      deliver(native)
    }

    void Linking.getInitialURL()
      .then(url => {
        if (launchAnswered) {
          return
        }

        launchAnswered = true
        deliver(url)
      })
      .catch(() => undefined)

    return () => {
      live = false
      subscription.remove()
    }
  }, [])
}
