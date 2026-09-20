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
