/**
 * Two RFCs implemented by hand, so both are checked against their own
 * definitions rather than against themselves.
 *
 * The encryption case DECRYPTS: it plays the browser's half of RFC 8291 with
 * the subscription's private key and reads the plaintext back out. A test that
 * only asserted "the body is longer than the input" would pass for a cipher
 * with the wrong key, the wrong nonce or the wrong info string, and all three
 * of those fail silently on a real push service as a notification that never
 * arrives.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { PushMessage } from './expo'
import type { PushRegistration } from './registrations'
import {
  encryptPayload,
  generateSubscriptionKeys,
  generateVapidKeys,
  privateKeyObject,
  RECORD_SIZE,
  sendWebPush,
  vapidAuthorization,
  vapidKeysUsable
} from './web-push'

const MESSAGE: PushMessage = { title: 'Researcher', body: 'sent you a message', data: { bot: 'researcher' } }

const webpush = (endpoint: string, keys: { p256dh: string; auth: string }): PushRegistration => ({
  installationId: 'dev-1',
  owner: '',
  transport: 'webpush',
  endpoint,
  keys,
  platform: 'web',
  types: { message: true, request: true, dm: true, cron: true, cron_done: true, cron_failed: true },
  preview: false,
  updatedAt: 0
})

/** The browser's half of RFC 8291 §3.4, so the envelope can be read back. */
function decrypt(body: Buffer, subscription: { p256dh: string; auth: string; privateKey: Buffer }): string {
  const salt = body.subarray(0, 16)
  const keyLength = body.readUInt8(20)
  const serverPublicKey = body.subarray(21, 21 + keyLength)
  const ciphertext = body.subarray(21 + keyLength)

  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(subscription.privateKey)
  const shared = ecdh.computeSecret(serverPublicKey)
  const userPublic = Buffer.from(subscription.p256dh, 'base64url')
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), userPublic, serverPublicKey])
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(subscription.auth, 'base64url'), keyInfo, 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])

  // The last byte is RFC 8188's record delimiter, not content.
  expect(plaintext[plaintext.length - 1]).toBe(0x02)

  return plaintext.subarray(0, plaintext.length - 1).toString('utf8')
}

describe('the application-server key pair', () => {
  it('is a raw P-256 point and scalar, which is what a browser subscribes against', () => {
    const keys = generateVapidKeys()
    const point = Buffer.from(keys.publicKey, 'base64url')

    expect(point).toHaveLength(65)
    expect(point[0]).toBe(0x04)
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32)
    expect(vapidKeysUsable(keys)).toBe(true)
  })

  it('rebuilds a signing key from the stored halves', () => {
    expect(() => privateKeyObject(generateVapidKeys())).not.toThrow()
    expect(vapidKeysUsable({ publicKey: 'AAAA', privateKey: 'AAAA' })).toBe(false)
    expect(vapidKeysUsable(undefined)).toBe(false)
  })
})

describe('the VAPID token', () => {
  const keys = generateVapidKeys()

  it('is an ES256 JWT a push service can verify with the advertised key', () => {
    const header = vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/abc', {
      keys,
      subject: 'https://hermie.dev',
      now: () => 1_800_000_000
    })
    const token = /^vapid t=([^,]+), k=(.+)$/u.exec(header)

    expect(token).not.toBeNull()

    const [, jwt = '', advertised = ''] = token ?? []
    const [head = '', claims = '', signature = ''] = jwt.split('.')

    expect(advertised).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' })

    const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>

    // The audience is the push service's ORIGIN, so a token minted for one
    // service is not replayable against another.
    expect(body.aud).toBe('https://updates.push.services.mozilla.com')
    expect(body.sub).toBe('https://hermie.dev')
    expect(body.exp).toBe(1_800_000_000 + 12 * 60 * 60)

    const spki = Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      Buffer.from(keys.publicKey, 'base64url')
    ])

    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`, 'utf8'),
        { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true)
  })
})

describe('the encrypted envelope', () => {
  it('decrypts with the subscription’s own keys', () => {
    const subscription = generateSubscriptionKeys()
    const { body } = encryptPayload('the quick brown fox', subscription)

    expect(decrypt(body, subscription)).toBe('the quick brown fox')
  })

  it('has the aes128gcm header RFC 8188 describes', () => {
    const subscription = generateSubscriptionKeys()
    const { body, salt, serverPublicKey } = encryptPayload('x', subscription)

    expect(body.subarray(0, 16).equals(salt)).toBe(true)
    expect(body.readUInt32BE(16)).toBe(RECORD_SIZE)
    expect(body.readUInt8(20)).toBe(65)
    expect(body.subarray(21, 86).equals(serverPublicKey)).toBe(true)
  })

  it('is different every time, because the ephemeral key and the salt are', () => {
    const subscription = generateSubscriptionKeys()

    expect(encryptPayload('same', subscription).body.equals(encryptPayload('same', subscription).body)).toBe(false)
  })

  it('refuses a payload that does not fit one record, rather than truncating it', () => {
    expect(() => encryptPayload('x'.repeat(RECORD_SIZE), generateSubscriptionKeys())).toThrow(/one 4096-byte record/)
  })

  it('refuses a subscription key that is not a P-256 point', () => {
    expect(() => encryptPayload('x', { p256dh: 'AAAA', auth: 'AAAAAAAAAAAAAAAAAAAAAA' })).toThrow(/P-256 point/)
  })
})

describe('sending', () => {
  const keys = generateVapidKeys()
  const vapid = { keys, subject: 'https://hermie.dev' }

  it('posts the envelope with the headers a push service requires', async () => {
    const subscription = generateSubscriptionKeys()
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })

      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch

    const result = await sendWebPush([webpush('https://push.test/ep', subscription)], MESSAGE, { vapid, fetchImpl })

    expect(result.dead).toEqual([])
    expect(result.statuses['dev-1']).toBe(201)

    const headers = calls[0]?.init.headers as Record<string, string>

    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers.authorization?.startsWith('vapid t=')).toBe(true)
    expect(decrypt(Buffer.from(calls[0]?.init.body as Uint8Array), subscription)).toContain('sent you a message')
  })

  it('removes a subscription the push service says is gone, and only then', async () => {
    const subscription = generateSubscriptionKeys()

    for (const status of [404, 410]) {
      const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
      const result = await sendWebPush([webpush('https://push.test/ep', subscription)], MESSAGE, { vapid, fetchImpl })

      expect(result.dead).toEqual(['dev-1'])
    }

    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
      const result = await sendWebPush([webpush('https://push.test/ep', subscription)], MESSAGE, { vapid, fetchImpl })

      // A statement about the moment. Forgetting a device over one would cost
      // the owner a re-subscription for nothing.
      expect(result.dead).toEqual([])
    }
  })

  it('survives a network that is simply not there', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await sendWebPush([webpush('https://push.test/ep', generateSubscriptionKeys())], MESSAGE, {
      vapid,
      fetchImpl
    })

    expect(result.dead).toEqual([])
  })

  it('leaves an Expo registration to the Expo sender', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const expo: PushRegistration = {
      installationId: 'dev-2',
      owner: '',
      transport: 'expo',
      token: 'ExponentPushToken[x]',
      platform: 'ios',
      types: { message: true, request: true, dm: true, cron: true, cron_done: true, cron_failed: true },
      preview: false,
      updatedAt: 0
    }

    expect((await sendWebPush([expo], MESSAGE, { vapid, fetchImpl })).statuses).toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
