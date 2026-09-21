/**
 * The browser's half of ADR-0017: a service worker and a `PushSubscription`.
 *
 * Nothing here talks to the daemon either. The subscription the browser mints is
 * written into the same `ui_meta` section the phones use — endpoint and keys
 * instead of a token, which is the one place the two transports differ — and the
 * daemon signs its sends with the VAPID key pair it generated on first run.
 *
 * **Three conditions, and all three are the platform's, not ours.**
 *
 *  - *A secure context.* `navigator.serviceWorker` and `PushManager` do not
 *    exist over plain http, except on `localhost`. ADR-0017 already says Web
 *    Push works only where Hermie Web is served over TLS, so this reports
 *    `available: false` rather than pretending and failing later.
 *  - *A public key.* `applicationServerKey` is required for a `userVisibleOnly`
 *    subscription, and the only place it comes from is the daemon's
 *    `GET /push/vapid-public-key` — same origin, because the daemon serves this
 *    page too.
 *  - *Permission, granted from a gesture.* `Notification.requestPermission()`
 *    must run inside a user activation in several browsers, which is why the
 *    switch in Settings is what calls it rather than anything on mount.
 */
import type { PushAddress } from '@hermie/gateway-client/push'

import { pushDataOf, type PushPermission, type PushPlatform, type PushResponse } from './platform-contract'

/** Where the worker lives once `expo export --platform web` has copied it. */
export const PUSH_SERVICE_WORKER_URL = '/hermie-push-sw.js'

/** The query the worker opens a cold tab with. Read once, then cleared. */
export const PUSH_LAUNCH_PARAM = 'hermiePush'

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof navigator !== 'undefined'

/**
 * Everything the Push API needs, present and usable.
 *
 * `isSecureContext` covers the `localhost` exemption on its own, so a developer
 * running the export on `http://localhost` gets the real path rather than a
 * second code path that only exists for them.
 */
function supported(): boolean {
  return (
    hasWindow() &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined' &&
    window.isSecureContext
  )
}

/**
 * base64url → the bytes `applicationServerKey` wants.
 *
 * Backed by an `ArrayBuffer` this function allocated, rather than by whatever
 * `Uint8Array`'s default type parameter is: `applicationServerKey` takes a
 * `BufferSource` that cannot be shared memory, and a view over a
 * `SharedArrayBuffer` is not one.
 */
export function decodeVapidKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.trim().replace(/-/gu, '+').replace(/_/gu, '/')
  const raw = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }

  return bytes
}

/** One subscription, as the section wants it, or `null` if it is not one. */
export function addressOfSubscription(subscription: PushSubscription | null): PushAddress | null {
  const json = subscription?.toJSON()
  const endpoint = typeof json?.endpoint === 'string' ? json.endpoint : ''
  const p256dh = typeof json?.keys?.p256dh === 'string' ? json.keys.p256dh : ''
  const auth = typeof json?.keys?.auth === 'string' ? json.keys.auth : ''

  // ADR-0017's reader drops a `webpush` row that is missing either key, so a
  // half-formed subscription is worth nothing and is reported as nothing.
  return endpoint && p256dh && auth ? { transport: 'webpush', endpoint, keys: { p256dh, auth } } : null
}

let registration: ServiceWorkerRegistration | null = null

async function ensureWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) {
    return null
  }

  if (registration) {
    return registration
  }

  try {
    registration = await navigator.serviceWorker.register(PUSH_SERVICE_WORKER_URL)
    await navigator.serviceWorker.ready
  } catch {
    // A worker that will not register — a file that is not there, a scope the
    // server will not allow — means no Web Push on this deployment.
    registration = null
  }

  return registration
}

const permissionOf = (value: NotificationPermission): PushPermission =>
  value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : 'undetermined'

let launchConsumed = false

export const pushPlatform: PushPlatform = {
  get available() {
    return supported()
  },
  platform: 'web',

  async prepare() {
    await ensureWorker()
  },

  async permission() {
    return supported() ? permissionOf(Notification.permission) : 'denied'
  },

  async requestPermission() {
    if (!supported()) {
      return 'denied'
    }

    if (Notification.permission !== 'default') {
      return permissionOf(Notification.permission)
    }

    return permissionOf(await Notification.requestPermission())
  },

  async obtainAddress(request): Promise<PushAddress | null> {
    const worker = await ensureWorker()

    if (!worker || !request.vapidUrl) {
      return null
    }

    // A subscription this browser already holds is reused: subscribing again
    // with a different key throws, and the endpoint it would mint is the same
    // one the section already names.
    const existing = addressOfSubscription(await worker.pushManager.getSubscription())

    if (existing) {
      return existing
    }

    let key: string

    try {
      const response = await fetch(request.vapidUrl, { credentials: 'same-origin' })

      if (!response.ok) {
        return null
      }

      const body = (await response.json()) as { key?: unknown; publicKey?: unknown }

      key = typeof body.key === 'string' ? body.key : typeof body.publicKey === 'string' ? body.publicKey : ''
    } catch {
      // No daemon, no route, no key: push is not available on this deployment,
      // which is a thing Settings says rather than an error.
      return null
    }

    if (!key) {
      return null
    }

    try {
      const subscription = await worker.pushManager.subscribe({
        // Required by every browser that implements Push: a subscription that
        // may deliver silently is one Chrome refuses outright.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(key)
      })

      return addressOfSubscription(subscription)
    } catch {
      return null
    }
  },

  async dropAddress() {
    const worker = await ensureWorker()
    const subscription = await worker?.pushManager.getSubscription()

    try {
      await subscription?.unsubscribe()
    } catch {
      // The row leaving `ui_meta` is what actually stops the sends. An endpoint
      // the browser would not release is one the daemon will retire on its own
      // when it answers 404 or 410.
    }
  },

  onResponse(handler) {
    if (!supported()) {
      return () => undefined
    }

    const listener = (event: MessageEvent): void => {
      const message = event.data as { source?: unknown; response?: unknown } | null

      if (!message || message.source !== 'hermie-push') {
        return
      }

      const response = message.response as { actionIdentifier?: unknown; data?: unknown } | null

      handler({
        actionIdentifier: typeof response?.actionIdentifier === 'string' ? response.actionIdentifier : 'default',
        data: pushDataOf(response?.data)
      })
    }

    navigator.serviceWorker.addEventListener('message', listener)

    return () => navigator.serviceWorker.removeEventListener('message', listener)
  },

  async consumeInitialResponse(): Promise<PushResponse | null> {
    if (!hasWindow() || launchConsumed) {
      return null
    }

    launchConsumed = true

    const url = new URL(window.location.href)
    const raw = url.searchParams.get(PUSH_LAUNCH_PARAM)

    if (!raw) {
      return null
    }

    // Out of the address bar before anything else runs: a reload of a URL that
    // still carries it would act on the same click a second time.
    url.searchParams.delete(PUSH_LAUNCH_PARAM)
    window.history.replaceState(null, '', url.toString())

    try {
      const parsed = JSON.parse(raw) as { actionIdentifier?: unknown; data?: unknown }

      return {
        actionIdentifier: typeof parsed.actionIdentifier === 'string' ? parsed.actionIdentifier : 'default',
        data: pushDataOf(parsed.data)
      }
    } catch {
      return null
    }
  }
}
