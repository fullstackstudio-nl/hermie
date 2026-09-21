/**
 * The whole path, end to end: a device registered in `ui_meta`, something
 * happening on a real socket, and a real request going out to a push service.
 *
 * The unit suites check each piece against its own definition. This one checks
 * the thing those cannot: that the pieces are wired to each other at all. Only
 * the two push services are stubbed — everything between the gateway and the
 * outgoing HTTP request is the code that ships, including the classification
 * that reads a cron header out of a transcript and the encryption that a browser
 * has to be able to undo.
 */
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startPushDaemon, type PushDaemon } from './daemon'
import { EXPO_SEND_URL } from './expo'
import { PUSH_SECTION_VERSION } from './registrations'
import { generateSubscriptionKeys } from './web-push'

interface OutgoingPush {
  url: string
  init: RequestInit
}

const subscription = generateSubscriptionKeys()

const expoRegistration = (over: Record<string, unknown> = {}) => ({
  v: PUSH_SECTION_VERSION,
  transport: 'expo',
  token: 'ExponentPushToken[phone]',
  platform: 'ios',
  types: { message: true, request: true, dm: true, cron: true },
  preview: false,
  updatedAt: 1,
  ...over
})

const webRegistration = () => ({
  v: PUSH_SECTION_VERSION,
  transport: 'webpush',
  endpoint: 'https://push.test/subscription',
  keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  platform: 'web',
  types: { message: true, request: true, dm: true, cron: true },
  preview: false,
  updatedAt: 1
})

let gateway: FakeGateway
let daemon: PushDaemon
let stateDir: string
let outgoing: OutgoingPush[]

const captureFetch = (): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    outgoing.push({ url: String(input), init: init ?? {} })

    return String(input) === EXPO_SEND_URL
      ? new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 })
      : new Response(null, { status: 201 })
  }) as unknown as typeof fetch

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> => {
  const until = Date.now() + timeoutMs

  while (Date.now() < until) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`timed out waiting for ${label}`)
}

const start = async (options: { registrations?: Record<string, unknown>; seen?: Record<string, number> } = {}) => {
  gateway = await startFakeGateway({
    port: 0,
    streamDelayMs: 1,
    pushRegistrations: options.registrations ?? { phone: expoRegistration() },
    ...(options.seen ? { pushSeen: options.seen } : {})
  })
  daemon = await startPushDaemon({
    gatewayUrl: gateway.url,
    stateDir,
    version: '9.9.9',
    log: () => undefined,
    fetchImpl: captureFetch(),
    pollReceipts: false,
    sleep: () => Promise.resolve(),
    random: () => 0,
    // The real clocks are minutes long; the behaviour is the same at zero.
    tuning: { openingGraceMs: 0, registrationTtlMs: 0 }
  })
  // `resumed`, not `watched`: the roster is read before the resumes are made,
  // and an event that arrives between the two belongs to no session yet.
  await waitFor(() => (daemon.watcher?.resumed.length ?? 0) > 1, 'both chats to be resumed')
}

/** The browser's half of RFC 8291, so a real subscription's key is what opens it. */
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16)
  const serverPublicKey = body.subarray(21, 21 + body.readUInt8(20))
  const ciphertext = body.subarray(21 + body.readUInt8(20))
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(subscription.privateKey)
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      ecdh.computeSecret(serverPublicKey),
      Buffer.from(subscription.auth, 'base64url'),
      Buffer.concat([
        Buffer.from('WebPush: info\0', 'utf8'),
        Buffer.from(subscription.p256dh, 'base64url'),
        serverPublicKey
      ]),
      32
    )
  )
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])

  return plaintext.subarray(0, plaintext.length - 1).toString('utf8')
}

const expoBody = (call: OutgoingPush): Record<string, unknown> =>
  (JSON.parse(String(call.init.body)) as Record<string, unknown>[])[0] ?? {}

/** A turn the owner started: the case every other classification has to beat. */
const plainTurn = async (): Promise<void> => {
  const response = await fetch(`${gateway.url}/__fake/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'researcher', user: 'what is the weather?', assistant: 'sunny, mostly' })
  })

  expect(response.status).toBe(200)
}

beforeEach(async () => {
  outgoing = []
  stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-push-e2e-'))
})

afterEach(async () => {
  await daemon.stop()
  await gateway.close()
})

describe('a registration, an event, one push', () => {
  it('sends a cron delivery to the registered device, saying who and not what', async () => {
    await start()
    gateway.deliverCron({ job: 'Morning digest', report: 'The overnight numbers are in.' })

    await waitFor(() => outgoing.some(call => call.url === EXPO_SEND_URL), 'the Expo send')

    const body = expoBody(outgoing.find(call => call.url === EXPO_SEND_URL) as OutgoingPush)

    expect(body.to).toBe('ExponentPushToken[phone]')
    expect(body.title).toBe('Researcher')
    expect(body.body).toBe('cron “Morning digest” reported')
    expect((body.data as Record<string, string>).type).toBe('cron')
    // Preview is off: the report itself never leaves the gateway.
    expect(JSON.stringify(body)).not.toContain('overnight numbers')
  })

  it('reads a bot-to-bot delivery as a DM and names the sender', async () => {
    await start()
    gateway.deliverBotDm({ from: 'Writer', handle: 'writer' })

    await waitFor(() => outgoing.some(call => call.url === EXPO_SEND_URL), 'the Expo send')

    expect(expoBody(outgoing[0] as OutgoingPush).body).toBe('heard from Writer')
  })

  it('sends an approval, with the id the app re-validates before answering anything', async () => {
    await start()
    void gateway.raiseApprovalOn({ command: 'rm -rf ./build' }).catch(() => undefined)

    await waitFor(() => outgoing.some(call => call.url === EXPO_SEND_URL), 'the Expo send')

    const body = expoBody(outgoing[0] as OutgoingPush)

    expect(body.body).toBe('is waiting for your approval')
    expect(body.categoryId).toBe('hermie.approval')
    expect((body.data as Record<string, string>).request).toBeTruthy()
    // The command is in the request, not in the notification.
    expect(JSON.stringify(body)).not.toContain('rm -rf')
  })
})

describe('somebody is already reading', () => {
  it('says nothing about an ordinary message when a heartbeat is fresh', async () => {
    await start({ seen: { phone: Math.floor(Date.now() / 1000) } })
    await plainTurn()

    await new Promise(resolve => setTimeout(resolve, 250))
    await daemon.watcher?.settle()

    expect(outgoing).toHaveLength(0)
  })

  it('says it once the heartbeat has gone stale', async () => {
    // The same turn, the same device: only the age of the stamp differs, which
    // is the whole of the heuristic ADR-0017 admits to.
    await start({ seen: { phone: Math.floor(Date.now() / 1000) - 600 } })
    await plainTurn()

    await waitFor(() => outgoing.length > 0, 'the Expo send')

    expect(expoBody(outgoing[0] as OutgoingPush).body).toBe('sent you a message')
  })

  it('still says something about an approval, because a countdown does not wait for a tab', async () => {
    await start({ seen: { phone: Math.floor(Date.now() / 1000) } })
    void gateway.raiseApprovalOn().catch(() => undefined)

    await waitFor(() => outgoing.length > 0, 'the Expo send')

    expect(expoBody(outgoing[0] as OutgoingPush).body).toBe('is waiting for your approval')
  })
})

describe('across a reconnect', () => {
  it('does not send the same event twice when the replay brings it back', async () => {
    await start()
    const storedId = [...gateway.state.sessions.keys()][0] as string

    gateway.deliverCron({ job: 'Morning digest' })
    await waitFor(() => outgoing.length > 0, 'the first send')
    const before = outgoing.length

    // The socket dies; the replay ring still holds the turn that was just sent.
    gateway.dropSockets()
    await waitFor(() => daemon.link.connected, 'the reconnection')
    await waitFor(
      () => gateway.state.eventsSinceCalls.some(call => call.session_id === gateway.state.sessions.get(storedId)?.id),
      'the replay'
    )
    await new Promise(resolve => setTimeout(resolve, 250))
    await daemon.watcher?.settle()

    expect(outgoing).toHaveLength(before)
  })
})

describe('Web Push', () => {
  it('produces an envelope the subscription’s own key opens', async () => {
    await start({ registrations: { browser: webRegistration() } })
    gateway.deliverCron({ job: 'Morning digest' })

    await waitFor(() => outgoing.some(call => call.url === 'https://push.test/subscription'), 'the Web Push send')

    const call = outgoing.find(entry => entry.url === 'https://push.test/subscription') as OutgoingPush
    const headers = call.init.headers as Record<string, string>

    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers.authorization.startsWith('vapid t=')).toBe(true)

    const payload = JSON.parse(decrypt(Buffer.from(call.init.body as Uint8Array))) as Record<string, unknown>

    expect(payload.title).toBe('Researcher')
    expect(payload.body).toBe('cron “Morning digest” reported')
  })
})

describe('the control endpoint', () => {
  it('registers a device and raises an approval over HTTP, with no socket of its own', async () => {
    // What a manual run needs: `curl` the fixture in, `curl` the event, watch
    // the phone. The programmatic helpers above are the same two calls.
    await start({ registrations: {} })

    expect(daemon.watcher?.registrations).toHaveLength(0)

    await fetch(`${gateway.url}/__fake/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'registrations', registrations: { phone: expoRegistration() } })
    })
    await waitFor(() => (daemon.watcher?.registrations.length ?? 0) > 0, 'the registration to be read')

    await fetch(`${gateway.url}/__fake/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approval', profile: 'researcher' })
    })
    await waitFor(() => outgoing.length > 0, 'the Expo send')

    expect(expoBody(outgoing[0] as OutgoingPush).body).toBe('is waiting for your approval')
  })
})

describe('a registration the daemon cannot address', () => {
  it('costs that entry and nothing else', async () => {
    await start({ registrations: { broken: expoRegistration({ token: '' }), phone: expoRegistration() } })
    gateway.deliverCron({ job: 'Morning digest' })

    await waitFor(() => outgoing.length > 0, 'the Expo send')

    expect(daemon.watcher?.registrations.map(entry => entry.installationId)).toEqual(['phone'])
    expect(expoBody(outgoing[0] as OutgoingPush).to).toBe('ExponentPushToken[phone]')
  })
})
