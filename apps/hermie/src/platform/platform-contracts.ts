/**
 * The contracts the platform seams answer, with no platform in them.
 *
 * A `.web.ts` seam replaces its whole module, so a seam that imported its own
 * type from the module it replaces would import itself — on the web,
 * `./secret-store` resolves to `secret-store.web.ts`. Every type two seams
 * share therefore lives here, where neither owns it, and each seam re-exports
 * the ones its callers expect to find next to the implementation.
 */

/**
 * Storage for values that must never land in a plain-text preference file:
 * access and refresh tokens, the ungated session token, and any extra request
 * headers the operator configured.
 *
 * On the web there is no keychain behind this; see `secret-store.web.ts`.
 */
export type SecretStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * The three moments a chat is allowed to buzz.
 *
 * Deliberately a closed set rather than a pass-through of the Expo API. Haptics
 * read as punctuation: one on committing a message, one on committing an answer
 * to a question the agent asked, one when a reply lands. Anything more and the
 * phone is vibrating at the user for things they did not do.
 */
export type HapticMoment = 'send' | 'choice' | 'complete'

/**
 * "Is there a network", as the connection's dial ladder asks it.
 *
 * One subscription that reports the current value immediately and then on every
 * change, and returns its own unsubscribe.
 */
export interface NetworkWatcher {
  subscribe(onChange: (online: boolean) => void): () => void
}

/** Which ink the system status bar draws its clock and indicators in. */
export type StatusBarInk = 'light' | 'dark'

/**
 * What the shell around the app is told about the app's appearance.
 *
 * `ink` is the only half the phones use; `background` exists for the browser,
 * where there is no status bar to tint but there IS a document whose
 * `theme-color` and page background have to follow the theme the visitor
 * pinned. It is handed down rather than read from the theme inside the seam,
 * because the theme provider is what renders this and a seam that imported it
 * back would close a module cycle.
 */
export interface SystemChromeProps {
  ink: StatusBarInk
  /** The app's wallpaper fill, as a CSS-ready colour. */
  background: string
}

/**
 * One file the user picked, in whichever form this platform hands it over.
 *
 * `body` is appended to a `FormData` as-is: a `File` in a browser, and the
 * `{uri, name, type}` blob React Native's own `FormData` streams from on the
 * phones and the Mac.
 */
export interface PickedFileSource {
  uri: string
  name: string | null
  /** Bytes. `0` when the platform did not say; the upload then finds out. */
  size: number
  mimeType: string | null
  body: unknown
}

/**
 * The shared container the home-screen widgets read out of.
 *
 * A widget is a separate process with its own sandbox, so nothing the app
 * writes into its own container is visible to one. Everything below writes into
 * the place both sides can reach — an App Group container on Apple platforms, a
 * named `SharedPreferences` file plus the app's files directory on Android —
 * and then asks the platform to redraw.
 *
 * Every method answers `false` rather than throwing when there is nowhere to
 * write. A home screen with no widget on it is the normal case, the web and the
 * Jest environment have no container at all, and none of that is a reason for a
 * message not to arrive.
 */
export interface WidgetBridge {
  /** Whether this platform has a shared container at all. */
  readonly available: boolean
  /** Replace the snapshot file and ask the platform to reload every timeline. */
  writeSnapshot(json: string): Promise<boolean>
  /** Put one PNG in the container, as raw base64 with no data-URL prefix. */
  writeAvatar(botName: string, base64: string): Promise<boolean>
  /** Delete every avatar whose bot is not in `keep`. Answers how many went. */
  pruneAvatars(keep: readonly string[]): Promise<number>
}
