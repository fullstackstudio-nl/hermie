/**
 * The seam between ADR-0017 and whatever the platform calls a notification.
 *
 * Three implementations answer this: `platform.ts` through `expo-notifications`
 * on iOS and Android, `platform.web.ts` through a service worker and the Push
 * API in a browser, and a hand-written object in a test. Everything above this
 * line — the store, the registration projection, the action validation — is
 * ordinary TypeScript with no native module in it, which is what makes the parts
 * that matter testable without a device.
 *
 * It is deliberately small. Obtaining an address, dropping it, asking for
 * permission, and hearing that somebody tapped something is the entire surface;
 * deciding what to do about any of it belongs on the other side.
 */

import type { PushAddress } from '@hermie/gateway-client/push'

/** ADR-0017's payload, as far as the app is willing to read it. */
export interface PushPayloadData {
  /** The bot whose chat this is about. */
  bot?: unknown
  /** `message`, `request`, `dm` or `cron`, as the daemon named it. */
  type?: unknown
  /** The approval or clarify this notification was raised for. */
  requestId?: unknown
  [key: string]: unknown
}

/** One tap, with whichever action it carried. */
export interface PushResponse {
  /**
   * The button, or the platform's own "the notification itself was tapped".
   *
   * `allow` and `deny` are ours, from the category below. Anything else — and
   * every value on a platform that has no categories — is a plain open.
   */
  actionIdentifier: string
  data: PushPayloadData
}

export type PushPermission = 'granted' | 'denied' | 'undetermined'

/** What `obtainAddress` needs from the app to ask the platform for an address. */
export interface PushAddressRequest {
  /** `extra.eas.projectId`, which is what mints an Expo token. Native only. */
  projectId: string | null
  /**
   * Where to fetch the VAPID public key. Browser only, and same-origin in
   * practice: the daemon serves both the page and `/push/vapid-public-key`.
   */
  vapidUrl: string | null
}

/** The category an approval notification is posted under, so it grows buttons. */
export const PUSH_REQUEST_CATEGORY = 'hermie.request'

/** Android's two channels: ADR-0017's four types collapse onto exactly these. */
export const PUSH_CHANNEL_DEFAULT = 'default'
export const PUSH_CHANNEL_NEEDS_INPUT = 'needs-input'

/** The two actions an approval notification offers. */
export const PUSH_ACTION_ALLOW = 'allow'
export const PUSH_ACTION_DENY = 'deny'

/**
 * The payload types that carry those two buttons.
 *
 * Only a blocked agent has an answer a button could send. A message, a DM and a
 * cron delivery have nothing to decide, so they are posted plain and a tap on
 * one is an ordinary open.
 */
export const PUSH_TYPES_WITH_ACTIONS: readonly string[] = ['request']

export interface PushPlatform {
  /** False where there is no notification machinery at all, and nothing throws. */
  readonly available: boolean
  /** `ios`, `android` or `web`. Written into the registration as a label. */
  readonly platform: string
  /** Register channels and categories. Idempotent; safe to call on every launch. */
  prepare(): Promise<void>
  permission(): Promise<PushPermission>
  /** Ask, if the platform still allows asking. Returns the settled answer. */
  requestPermission(): Promise<PushPermission>
  /** The address to register, or `null` if the platform would not give one. */
  obtainAddress(request: PushAddressRequest): Promise<PushAddress | null>
  /** Let the platform go: unsubscribe a browser, forget a token natively. */
  dropAddress(): Promise<void>
  /** Every tap while the app is running. Returns its own teardown. */
  onResponse(handler: (response: PushResponse) => void): () => void
  /**
   * The tap that STARTED this process, once.
   *
   * `consume` rather than `get`, for the reason `deep-link.ts` gives about a
   * launch URL: a value that is true for the life of the process is a value a
   * remount would act on again, and reopening the launch chat on every Fast
   * Refresh is exactly the bug that shape produces.
   */
  consumeInitialResponse(): Promise<PushResponse | null>
}

/** Read a notification's data defensively: it arrived from a push service. */
export function pushDataOf(value: unknown): PushPayloadData {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PushPayloadData) : {}
}
