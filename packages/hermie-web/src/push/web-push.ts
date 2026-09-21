/**
 * Web Push, from Node's own `crypto` and nothing else.
 *
 * Two RFCs, implemented here rather than depended on, because Hermie Web ships
 * with no runtime dependencies and a push library is a lot of surface to take on
 * for one POST:
 *
 *  - **RFC 8291** — the payload is encrypted END TO END, to a key pair the
 *    browser generated and never handed to anybody. The push service forwards
 *    ciphertext it cannot read, which is the only reason ADR-0017's `preview`
 *    switch can exist at all for this transport.
 *  - **RFC 8292 (VAPID)** — the request carries a signed assertion saying which
 *    application server sent it. It is not a secret and it does not authorise
 *    anything: it identifies, and it is what lets a push service rate-limit and
 *    contact the sender rather than blocking everyone.
 *
 * The content encoding is `aes128gcm` (RFC 8188), one record, which is what
 * every current browser takes and what keeps the framing to a fixed header.
 *
 * **The key pair must be stable.** A browser's subscription is bound to the
 * application-server key that created it, so regenerating one silently orphans
 * every registration ever handed out — which is why it lives in the state file
 * and not in memory.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

import type { PushMessage } from './expo'
import type { PushRegistration } from './registrations'
import type { VapidKeyPair } from './state'

/** One record, which is all a notification ever needs. RFC 8188 §2.1. */
export const RECORD_SIZE = 4096

/** Header + GCM tag + the 0x02 delimiter: what a record costs before any text. */
const OVERHEAD = 16 + 4 + 1 + 65 + 16 + 1

/** How long a push service should hold an undelivered notification. */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60

/** RFC 8292 §2 caps a VAPID token at 24 hours; half that leaves room for a slow clock. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60

/** The statuses that mean this subscription is finished and should be removed. */
const DEAD_ENDPOINT_STATUSES = new Set([404, 410])

const b64url = (bytes: Buffer): string => bytes.toString('base64url')

const fromB64url = (value: string): Buffer => Buffer.from(value, 'base64url')

/**
 * A fresh application-server key pair.
 *
 * `createECDH` is used rather than `generateKeyPairSync` because what has to be
 * stored — and what a browser subscribes against — is the RAW uncompressed
 * point and the raw scalar, not a PEM.
 */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()

  return {
    publicKey: b64url(ecdh.getPublicKey()),
    // A scalar with leading zero bytes comes back short; the templates below
    // want exactly 32.
    privateKey: b64url(padTo(ecdh.getPrivateKey(), 32))
  }
}

function padTo(value: Buffer, length: number): Buffer {
  return value.length >= length ? value : Buffer.concat([Buffer.alloc(length - value.length), value])
}

/**
 * A PKCS#8 P-256 private key, built around the raw scalar.
 *
 * Every byte outside the 32-byte scalar and the 65-byte point is fixed for this
 * curve, so the structure is a template rather than an encoder: SEQUENCE,
 * version, the two OIDs (`ecPublicKey`, `prime256v1`), then RFC 5915's
 * `ECPrivateKey` carrying the scalar and the public point.
 */
export function privateKeyObject(keys: VapidKeyPair) {
  const scalar = padTo(fromB64url(keys.privateKey), 32)
  const point = fromB64url(keys.publicKey)

  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('the stored VAPID public key is not an uncompressed P-256 point')
  }

  const der = Buffer.concat([
    Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
    scalar,
    Buffer.from('a144034200', 'hex'),
    point
  ])

  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** True for a key pair this build can actually sign with. Used by the tests and on load. */
export function vapidKeysUsable(keys: VapidKeyPair | undefined): boolean {
  if (!keys) {
    return false
  }

  try {
    privateKeyObject(keys)

    return true
  } catch {
    return false
  }
}

export interface VapidOptions {
  keys: VapidKeyPair
  /** `mailto:` or `https:`, RFC 8292 §2.1. A push service uses it to reach the sender. */
  subject: string
  now?: () => number
}

/**
 * The `Authorization` header for one push service.
 *
 * `aud` is the push service's ORIGIN, not the endpoint: a token minted for
 * Mozilla's service must not be replayable against Apple's, and the origin is
 * the granularity the RFC chose.
 */
export function vapidAuthorization(endpoint: string, options: VapidOptions): string {
  const now = options.now?.() ?? Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: now + JWT_LIFETIME_SECONDS, sub: options.subject }),
      'utf8'
    )
  )
  const signingInput = Buffer.from(`${header}.${claims}`, 'utf8')
  // `ieee-p1363` is the raw r||s JWS wants; Node's default is DER, which every
  // push service rejects with a 401 that says nothing useful.
  const signature = sign('sha256', signingInput, {
    key: privateKeyObject(options.keys),
    dsaEncoding: 'ieee-p1363'
  })

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${options.keys.publicKey}`
}

export interface EncryptedPayload {
  body: Buffer
  /** The ephemeral public key in the header, exposed so a test can decrypt. */
  serverPublicKey: Buffer
  salt: Buffer
}

/**
 * Encrypt one payload to a subscription, RFC 8291 §3.
 *
 * The two HKDF rounds are the whole of it: the first mixes the ECDH secret with
 * the subscription's `auth` secret and BOTH public keys — which is what binds
 * the ciphertext to this pair of parties and not merely to this curve — and the
 * second derives the content key and nonce from the record salt.
 */
export function encryptPayload(
  plaintext: Buffer | string,
  subscription: { p256dh: string; auth: string },
  options: { salt?: Buffer; ephemeral?: ReturnType<typeof createECDH> } = {}
): EncryptedPayload {
  const text = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext

  if (text.length + OVERHEAD > RECORD_SIZE) {
    throw new Error(`a Web Push payload must fit in one ${String(RECORD_SIZE)}-byte record`)
  }

  const userPublic = fromB64url(subscription.p256dh)
  const authSecret = fromB64url(subscription.auth)

  if (userPublic.length !== 65 || userPublic[0] !== 0x04) {
    throw new Error('the subscription key is not an uncompressed P-256 point')
  }

  const ephemeral = options.ephemeral ?? createECDH('prime256v1')

  if (!options.ephemeral) {
    ephemeral.generateKeys()
  }

  const serverPublicKey = ephemeral.getPublicKey()
  const sharedSecret = ephemeral.computeSecret(userPublic)
  const salt = options.salt ?? randomBytes(16)

  // RFC 8291 §3.3: "WebPush: info" || 0x00 || ua_public || as_public.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), userPublic, serverPublicKey])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  const contentKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  )
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  // 0x02 is the LAST-record delimiter of RFC 8188 §2; there is only one record.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([text, Buffer.from([0x02])])), cipher.final()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(serverPublicKey.length, 20)

  return { body: Buffer.concat([header, serverPublicKey, ciphertext, cipher.getAuthTag()]), serverPublicKey, salt }
}

export interface WebPushResult {
  /** Installation ids whose subscription is finished and should be removed. */
  dead: string[]
  /** Installation id → the status that came back, for the log. */
  statuses: Record<string, number>
}

export interface SendWebPushOptions {
  vapid: VapidOptions
  fetchImpl?: typeof fetch
  ttlSeconds?: number
}

/**
 * One notification to a set of Web Push registrations.
 *
 * A 404 or a 410 is the subscription saying it is gone and is the ONLY thing
 * that removes a registration. Everything else — a 5xx, a timeout, a refused
 * connection — is a statement about the moment, and a sender that forgot a
 * device over one would need the owner to subscribe again for no reason.
 */
export async function sendWebPush(
  registrations: readonly PushRegistration[],
  message: PushMessage,
  options: SendWebPushOptions
): Promise<WebPushResult> {
  const targets = registrations.filter(
    (registration): registration is PushRegistration & { endpoint: string; keys: { p256dh: string; auth: string } } =>
      registration.transport === 'webpush' && Boolean(registration.endpoint) && Boolean(registration.keys)
  )
  const send = options.fetchImpl ?? fetch
  const dead: string[] = []
  const statuses: Record<string, number> = {}

  for (const registration of targets) {
    let payload: EncryptedPayload

    try {
      payload = encryptPayload(
        JSON.stringify({ title: message.title, body: message.body, data: message.data }),
        registration.keys
      )
    } catch {
      // A subscription whose keys cannot be read is not a subscription. It is
      // dropped here rather than removed: the registration may simply predate a
      // schema this build knows, and removing it is the owner's decision.
      statuses[registration.installationId] = 0

      continue
    }

    try {
      const response = await send(registration.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(registration.endpoint, options.vapid),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
          urgency: message.categoryId ? 'high' : 'normal'
        },
        body: new Uint8Array(payload.body)
      })

      statuses[registration.installationId] = response.status

      if (DEAD_ENDPOINT_STATUSES.has(response.status)) {
        dead.push(registration.installationId)
      }
    } catch {
      // The network's problem, which says nothing about this subscription.
      statuses[registration.installationId] = 0
    }
  }

  return { dead, statuses }
}

/** Only used by the tests, to stand in for a browser's subscription. */
export function generateSubscriptionKeys(): { p256dh: string; auth: string; privateKey: Buffer } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()

  return {
    p256dh: b64url(ecdh.getPublicKey()),
    auth: b64url(randomBytes(16)),
    privateKey: ecdh.getPrivateKey()
  }
}
