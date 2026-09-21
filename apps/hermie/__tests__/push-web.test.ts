/**
 * The browser transport, as far as a test environment can honestly go.
 *
 * What CAN be checked here is everything between the browser's answer and the
 * `ui_meta` row: the VAPID key decoding, the projection of a `PushSubscription`
 * onto ADR-0017's `webpush` shape — including the half-formed ones the daemon's
 * reader would drop — and the gate that keeps the whole feature off where the
 * Push API does not exist.
 *
 * What CANNOT, and is therefore verified on a real browser or not at all:
 *
 *  - **Service-worker registration.** jsdom implements no
 *    `navigator.serviceWorker`, so `ensureWorker` is unreachable from here.
 *  - **`pushManager.subscribe`.** There is no push service to mint an endpoint,
 *    and no implementation of `applicationServerKey` to reject a bad one.
 *  - **The worker itself.** `public/hermie-push-sw.js` runs in a
 *    ServiceWorkerGlobalScope: `push`, `notificationclick`, `clients.matchAll`
 *    and `showNotification` have no stand-ins worth writing, because a stand-in
 *    for all four is a second implementation and it is the first one that has
 *    the bug.
 *  - **Permission from a user gesture.** Several browsers require
 *    `Notification.requestPermission()` to run inside a user activation, which
 *    is a property of the event loop rather than of the call.
 *
 * `docs/platform-notes.md` carries the same list, with what a person has to do
 * to close it.
 */
import { addressOfSubscription, decodeVapidKey, pushPlatform } from '../src/features/push/platform.web'

/** One subscription, as `toJSON()` renders it, without a browser. */
const subscription = (json: unknown) => ({ toJSON: () => json }) as unknown as PushSubscription

describe('the VAPID key', () => {
  it('decodes base64url, padding included, into the bytes subscribe wants', () => {
    // "hello" with the URL alphabet and no padding, which is how a server that
    // follows RFC 8292 publishes one.
    const bytes = decodeVapidKey('aGVsbG8')

    expect([...bytes]).toEqual([104, 101, 108, 108, 111])
    // Not a view onto shared memory: `applicationServerKey` refuses one.
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('accepts the `-` and `_` the URL alphabet uses', () => {
    expect([...decodeVapidKey('--__')]).toEqual([...decodeVapidKey('++//')])
  })
})

describe('a subscription, as a row', () => {
  it('becomes an endpoint and two keys, and never a token', () => {
    const address = addressOfSubscription(
      subscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'pp', auth: 'aa' } })
    )

    expect(address).toEqual({
      transport: 'webpush',
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'pp', auth: 'aa' }
    })
    expect(address && 'token' in address).toBe(false)
  })

  it('is nothing at all when a key is missing', () => {
    // The daemon drops a `webpush` row without both keys, so half a subscription
    // is worth nothing and is reported as nothing rather than registered.
    expect(
      addressOfSubscription(subscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'pp' } }))
    ).toBeNull()
    expect(addressOfSubscription(subscription({ keys: { p256dh: 'pp', auth: 'aa' } }))).toBeNull()
    expect(addressOfSubscription(null)).toBeNull()
  })
})

describe('the gate', () => {
  it('reports the platform as unavailable where there is no Push API', () => {
    // Which is also what happens over plain http: ADR-0017 says Web Push works
    // only where Hermie Web is served over TLS, and `isSecureContext` is how
    // the browser says so.
    expect(pushPlatform.available).toBe(false)
    expect(pushPlatform.platform).toBe('web')
  })

  it('asks for nothing and answers denied while it is unavailable', async () => {
    await expect(pushPlatform.permission()).resolves.toBe('denied')
    await expect(pushPlatform.requestPermission()).resolves.toBe('denied')
    await expect(
      pushPlatform.obtainAddress({ projectId: null, vapidUrl: '/push/vapid-public-key' })
    ).resolves.toBeNull()
    expect(pushPlatform.onResponse(() => undefined)).toBeInstanceOf(Function)
  })
})
